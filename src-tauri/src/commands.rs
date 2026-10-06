use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri::ipc::Channel;
use tauri_plugin_opener::OpenerExt;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const SECRET_SERVICE: &str = "mergehub";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const USER_AGENT: &str = concat!("MergeHub/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT_SECS: u64 = 10;
const STREAM_TOTAL_TIMEOUT_SECS: u64 = 600;
const STREAM_IDLE_TIMEOUT_SECS: u64 = 90;

const STREAM_CANCELLED: &str = "HTTP_STREAM_CANCELLED";

fn stream_cancels() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct StreamCancelGuard {
    request_id: Option<String>,
}

impl Drop for StreamCancelGuard {
    fn drop(&mut self) {
        if let Some(id) = self.request_id.take() {
            if let Ok(mut registry) = stream_cancels().lock() {
                registry.remove(&id);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpOptions {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResult {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[tauri::command]
pub async fn http_request(options: HttpOptions) -> Result<HttpResult, String> {
    let method = reqwest::Method::from_bytes(
        options
            .method
            .unwrap_or_else(|| "GET".to_string())
            .to_uppercase()
            .as_bytes(),
    )
    .map_err(|e| format!("无效的 HTTP 方法: {e}"))?;

    let timeout = Duration::from_secs(options.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut request = client
        .request(method, &options.url)
        .header("User-Agent", USER_AGENT);

    if let Some(headers) = &options.headers {
        for (name, value) in headers {
            request = request.header(name, value);
        }
    }

    if let Some(body) = &options.body {
        request = request.body(body.clone());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    Ok(HttpResult { status, headers, body })
}

#[tauri::command]
pub async fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_secret(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn delete_secret(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SECRET_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpStreamResult {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StreamEvent {
    #[serde(rename_all = "camelCase")]
    Chunk { data: String },
}

fn split_utf8_safe(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let owned = s.to_string();
            buf.clear();
            owned
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let owned = String::from_utf8_lossy(&buf[..valid]).into_owned();
            buf.drain(..valid);
            owned
        }
    }
}

#[tauri::command]
pub async fn http_request_stream(
    options: HttpOptions,
    on_event: Channel<StreamEvent>,
    request_id: Option<String>,
) -> Result<HttpStreamResult, String> {
    let (cancel_token, _cancel_guard) = match request_id {
        Some(id) => {
            let token = CancellationToken::new();
            if let Ok(mut registry) = stream_cancels().lock() {
                registry.insert(id.clone(), token.clone());
            }
            (
                Some(token),
                Some(StreamCancelGuard {
                    request_id: Some(id),
                }),
            )
        }
        None => (None, None),
    };

    let method = reqwest::Method::from_bytes(
        options
            .method
            .unwrap_or_else(|| "GET".to_string())
            .to_uppercase()
            .as_bytes(),
    )
    .map_err(|e| format!("无效的 HTTP 方法: {e}"))?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(STREAM_TOTAL_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut request = client
        .request(method, &options.url)
        .header("User-Agent", USER_AGENT);

    if let Some(headers) = &options.headers {
        for (name, value) in headers {
            request = request.header(name, value);
        }
    }

    if let Some(body) = &options.body {
        request = request.body(body.clone());
    }

    let send = request.send();
    let mut response = match &cancel_token {
        Some(token) => tokio::select! {
            _ = token.cancelled() => return Err(STREAM_CANCELLED.to_string()),
            waited = send => waited,
        },
        None => send.await,
    }
    .map_err(|e| format!("请求失败: {e}"))?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }

    if status >= 400 {
        let body = response
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {e}"))?;
        return Ok(HttpStreamResult {
            status,
            headers,
            body: Some(body),
        });
    }

    let mut utf8_buf: Vec<u8> = Vec::new();
    let mut received_any = false;
    loop {
        let wait = timeout(
            Duration::from_secs(STREAM_IDLE_TIMEOUT_SECS),
            response.chunk(),
        );
        let chunk = match &cancel_token {
            Some(token) => tokio::select! {
                _ = token.cancelled() => return Err(STREAM_CANCELLED.to_string()),
                waited = wait => waited,
            },
            None => wait.await,
        }
        .map_err(|_e| {
            let phase = if received_any {
                "模型输出中途停止"
            } else {
                "模型始终未输出任何数据"
            };
            // tokio Elapsed 的 Display 恒为英文 "deadline has elapsed"，与「空闲超时已到期」语义重复，不拼接仅保留中文阶段描述
            format!("模型响应中断：连续 {STREAM_IDLE_TIMEOUT_SECS} 秒未收到新数据（{phase}，空闲超时已到期），请重试")
        })?
        .map_err(|e| {
            // reqwest 总时长超限（.timeout）在流式读取中段以 Decode 错误呈现，
            // 需穿透识别真实超时来源，避免误导性的"error decoding response body"
            if e.is_timeout() {
                let phase = if received_any {
                    "模型输出中途被截断"
                } else {
                    "模型始终未完成输出"
                };
                format!(
                    "模型响应中断：总时长超过 {STREAM_TOTAL_TIMEOUT_SECS} 秒上限（{phase}），请重试或减小本次评审范围"
                )
            } else {
                format!("读取响应失败: {e}")
            }
        })?;

        let Some(bytes) = chunk else { break };
        received_any = true;
        utf8_buf.extend_from_slice(&bytes);
        let text = split_utf8_safe(&mut utf8_buf);
        if !text.is_empty() {
            on_event
                .send(StreamEvent::Chunk { data: text })
                .map_err(|e| format!("推送数据失败: {e}"))?;
        }
    }

    if !utf8_buf.is_empty() {
        let text = String::from_utf8_lossy(&utf8_buf).into_owned();
        let _ = on_event.send(StreamEvent::Chunk { data: text });
    }

    Ok(HttpStreamResult {
        status,
        headers,
        body: None,
    })
}

#[tauri::command]
pub async fn http_stream_cancel(request_id: String) -> Result<(), String> {
    let token = stream_cancels()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    if let Some(token) = token {
        token.cancel();
    }
    Ok(())
}

/// AI 调试日志目录名（位于应用本地数据目录下）
const AI_LOG_DIR: &str = "ai-logs";
/// AI 调试日志保留天数：超期文件在每次写入时循环清除
const AI_LOG_RETENTION_DAYS: u64 = 15;

/// 将仓库名净化为安全的目录名：仅保留字母、数字与 -_.，其余替换为下划线
fn sanitize_repo_name(repo: &str) -> String {
    let out: String = repo
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        "_".to_string()
    } else {
        out
    }
}

/// 解析日志目录：{app_local_data_dir}/ai-logs/{repo}
fn ai_log_dir(app: &tauri::AppHandle, repo: &str) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    Ok(base.join(AI_LOG_DIR).join(sanitize_repo_name(repo)))
}

/// 删除保留期之外的 .log 文件（按文件修改时间判断，循环清除）
fn remove_expired_logs(dir: &std::path::Path) {
    let expire = Duration::from_secs(AI_LOG_RETENTION_DAYS * 24 * 60 * 60);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "log").unwrap_or(false) {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if let Ok(age) = SystemTime::now().duration_since(modified) {
                    if age > expire {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLogAppendResult {
    pub file_path: String,
    pub dir_path: String,
}

/// 追加一段 AI 调试日志：按仓库分目录、按日期分文件，写入前循环清除超期日志
#[tauri::command]
pub async fn append_ai_debug_log(
    app: tauri::AppHandle,
    repo: String,
    file_name: String,
    content: String,
) -> Result<AiLogAppendResult, String> {
    let bytes = file_name.as_bytes();
    let valid = bytes.len() == 14
        && file_name.ends_with(".log")
        && bytes[..10].iter().all(|b| b.is_ascii_digit() || *b == b'-');
    if !valid {
        return Err("非法的日志文件名，应为 yyyy-MM-dd.log".to_string());
    }

    let dir = ai_log_dir(&app, &repo)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    remove_expired_logs(&dir);

    let file_path = dir.join(&file_name);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("无法写入日志文件：{e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("日志写入失败：{e}"))?;

    Ok(AiLogAppendResult {
        file_path: file_path.to_string_lossy().to_string(),
        dir_path: dir.to_string_lossy().to_string(),
    })
}

/// 打开 AI 调试日志所在文件夹（先确保目录存在）
#[tauri::command]
pub async fn open_ai_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let dir = base.join(AI_LOG_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开文件夹：{e}"))
}

/// 用系统文件管理器打开指定文件夹（本地仓库所在目录；目录不存在时给出明确提示）
#[tauri::command]
pub async fn open_local_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err("文件夹不存在或已被移动，请先在列表中移除后重新添加".into());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("无法打开文件夹：{e}"))
}
