mod commands;
mod git;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 显式标注 Wry：Context::config() 带 Runtime 泛型约束，宏展开类型需单一路径可推断
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    // updater 插件强制要求 plugins.updater 配置且 pubkey 必填（无默认值），缺失时插件
    // 初始化直接 panic（10-22 移除占位配置后 dev 启动复现，exit 101）。
    // 评审五轮：仅判 "updater" 键存在不够——配置对象存在但 pubkey 缺失/为空时仍会 panic，
    // 故校验 pubkey 为非空字符串后才有条件注册；真公钥配置就位后自动启用，Rust 侧无需再改。
    let updater_configured = context
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|p| p.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let builder = if updater_configured {
        tauri::Builder::default().plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        tauri::Builder::default()
    };
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::http_request,
            commands::http_request_stream,
            commands::http_stream_cancel,
            commands::set_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::append_ai_debug_log,
            commands::open_ai_log_dir,
            commands::open_local_folder,
            git::git_repo_info,
            git::git_diff,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_push,
            git::git_remotes,
            git::read_local_file
        ])
        .setup(|app| {
            let data_dir = std::env::var("MERGEHUB_WEBVIEW_DATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    app.path()
                        .app_local_data_dir()
                        .expect("failed to resolve app local data dir")
                });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("MergeHub · 合并审批中心")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .data_directory(data_dir)
                .build()?;

            Ok(())
        })
        // 复用开头构建的 Context（评审 10-22 二轮：重复 generate_context! 白做一次资源解析）
        .run(context)
        .expect("error while running tauri application");
}
