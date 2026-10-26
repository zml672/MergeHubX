//! 文件持久化底座（P1-17）：前端 storage.ts 门面的文件侧。
//!
//! 设计（§4.3 立项详案）：
//! - 每 key 一个 JSON 文件，key → 相对路径的映射由前端 REGISTRY 单源维护，
//!   本模块只认「相对路径」不认语义——前端传 `ai/profiles.json` 就读写对应文件。
//! - 数据根默认 `{app_local_data_dir}/mergehub-data`，可经 root.json 指针重定向到
//!   任意用户目录；指针损坏或目标不可达时降级回默认位置（不崩、不丢）。
//! - 写入一律原子写：先写同目录 `.tmp` 再 rename 覆盖，任一时刻断电不留半个坏文件。
//! - key 防穿越：相对路径只允许 `字母数字-_/.`，拒绝 `..` 段、绝对路径、盘符，
//!   拼接后必须仍位于数据根之内。
//!
//! 全局不变式（评审 storage.rs:441/485/229 全局收敛，点状修法升级为纪律）：
//! - **异步层零文件 IO**：所有 `#[tauri::command]` 的 async 函数体只做纯字符串校验与
//!   任务编排，对文件系统的任何接触（含数据根解析读 root.json）一律在 spawn_blocking
//!   线程内——慢盘/杀软扫描/网络盘挂起只占用阻塞线程池，不卡 tokio worker。
//! - **路径关系判定基于规范化形态**：用户提供的绝对路径在入口（target_of）经
//!   normalize_components 词法消除 `.`/`..`，指针回读同样规范化；全部 starts_with
//!   嵌套判定因此词法可靠，`..` 无法绕过（防自嵌套复制）。
//! - **迁移是可重试状态机**：锁内复核目标为空 → 复制 → 建目录 → 指针原子写（最后
//!   一步）；复制失败自动清理本次半成品（复制前已验证目标为空，残留必为本次所产），
//!   排除故障后同路径重试永远畅通，不被「目标非空」卡死。

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 数据根默认目录名（位于应用本地数据目录下）
const DATA_ROOT_DIR: &str = "mergehub-data";
/// 数据根指针文件名（永远位于应用本地数据目录下，不随数据根迁移）
const ROOT_POINTER_FILE: &str = "root.json";

/// 自定义数据根不可达时的统一拒绝文案（降级位置不可静默读写：数据分叉无感知）
const DEGRADED_ERR: &str =
    "自定义存储位置当前不可达（U 盘未接入或网络盘未挂载），已暂停读写以保护数据；目录恢复后重启应用即自动切回";

/// 数据根搬迁进行中标志：复制期间拒绝新写入——否则复制快照里的数据落后于旧根，
/// 指针切换后这些写入既不在新根也无提示，静默丢失
static RELOCATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 数据根文件级互斥（评审五轮 #1 完备解）：写命令的实际 IO 与迁移复制全程在同一把
/// 锁下串行——复制期间旧根无任何并发写，一轮复制即完整快照；IO 内拿锁后重新解析
/// key 路径，排队等到指针切换之后的写直接解析到新根并落新根，不再丢失。
/// 全部锁操作都在 spawn_blocking 线程内完成（不跨 await，规避 MutexGuard 非 Send）；
/// mutex 里放 () 是因为互斥本身就是全部目的，不共享数据
static DATA_ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 拿数据根互斥锁；中毒锁（持锁线程 panic）直接取内部数据继续——锁内只是 IO，
/// panic 留下的不一致不是锁能修复的，阻塞在毒锁上反而让存储永久不可用
fn lock_data_root() -> std::sync::MutexGuard<'static, ()> {
    DATA_ROOT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 写路径的搬迁互斥检查（storage_write / storage_append / storage_remove /
/// storage_remove_dir 入口调用）：快速失败路径——迁移在途时多数写请求在此直接拒绝，
/// 不必排队等锁；极小概率「检查通过后迁移开始」的请求由 IO 内的锁+严格检查兜底
fn reject_if_relocating() -> Result<(), String> {
    if RELOCATING.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("数据位置迁移正在进行中，写入已暂停；迁移完成后请重试".into());
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct RootPointer {
    /// 数据根当前指向的绝对路径
    #[serde(rename = "dataRoot")]
    data_root: String,
    /// 指针结构版本（预留；当前恒为 1）
    #[serde(default = "default_pointer_version")]
    v: u32,
}

fn default_pointer_version() -> u32 {
    1
}

/// 应用本地数据目录（root.json 所在地）
fn app_data_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))
}

/// root.json 路径
fn root_pointer_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_base(app)?.join(ROOT_POINTER_FILE))
}

/// 判断自定义数据根是否可用：存在且是目录，或其父目录存在（可创建）
fn data_root_reachable(path: &Path) -> bool {
    if path.is_dir() {
        return true;
    }
    // 不存在时看父目录能否创建（U 盘拔出后整条链路不存在）
    path.parent().is_some_and(|p| p.is_dir())
}

/// 词法规范化绝对路径（评审 storage.rs:441 全局原语）：components 逐分量消除 `.`
/// 与 `..`（前者删除，后者弹出上一分量），`..` 弹空时保留语义上界（盘符/根前无法
/// 上溯则丢弃该 `..`，Windows 下 `C:\..` 即 `C:\`）。
/// 所有用户提供的绝对路径（迁移目标、指针回读）必须经此处理再做 starts_with
/// 嵌套判定——否则 `C:\data\..\data\root\new` 这类路径词法上绕过嵌套检查，
/// 实际解析后落在数据根内部，copy_dir_recursive 会把目标（位于源内部）当源条目
/// 递归复制成自嵌套，路径超长/磁盘耗尽。
/// 词法规范化（不触盘）而非 canonicalize（触盘且解析符号链接/junction）的理由：
/// 嵌套判定只需要分量级正确；junction/symlink 层的物理别名不改变用户声明的
/// 逻辑位置语义，且触盘规范化在目标尚未创建时必失败，还得走「最近存在父目录
/// 回溯拼接」的复杂路径引入新的错误面。
fn normalize_components(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    // 无分量可弹（根/盘符前缀之上）：丢弃该 ..，等价于停在根
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 降级原因：决定拒绝文案与处理策略——不可达是暂态（U 盘插回即恢复，保护性拒写），
/// 指针损坏是持久态（每秒读都会失败，需引导用户修复/删除 root.json）
#[derive(Debug, Clone, Copy, PartialEq)]
enum DegradedReason {
    /// 指针指向的目录不可达（U 盘未接入/网络盘未挂载）
    Unreachable,
    /// root.json 内容损坏（非 JSON / 缺字段）
    PointerCorrupt,
}

impl DegradedReason {
    fn message(self) -> &'static str {
        match self {
            Self::Unreachable => DEGRADED_ERR,
            Self::PointerCorrupt => {
                "数据根指针文件（root.json）已损坏，应用暂时使用默认存储位置以保护数据；请勿手工编辑该文件，可将其删除后重启应用恢复默认配置"
            }
        }
    }
}

/// 解析数据根：
/// 1. 读 root.json；无指针 → 默认位置（正常）；
/// 2. 指针存在但 JSON 损坏 → 降级默认（PointerCorrupt），不回写不误删（文件可能只是临时读坏）；
/// 3. 指针合法但目标不可达 → 降级默认（Unreachable），不回写（U 盘插回指针继续生效）。
///
/// 返回 (数据根路径, Option<降级原因>)。None 表示正常。
///
/// 可见性：仅本模块内使用（各 storage/data_root 命令的公共入口都在本文件），
/// 保持私有与 DegradedReason 同级，避免 pub 接口暴露私有类型触发 private_interfaces。
fn resolve_data_root(app: &tauri::AppHandle) -> Result<(PathBuf, Option<DegradedReason>), String> {
    let default_root = app_data_base(app)?.join(DATA_ROOT_DIR);
    let pointer_path = root_pointer_path(app)?;
    let Ok(raw) = fs::read_to_string(&pointer_path) else {
        return Ok((default_root, None));
    };
    let pointer: RootPointer = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => return Ok((default_root, Some(DegradedReason::PointerCorrupt))),
    };
    let custom = normalize_components(Path::new(&pointer.data_root));
    if !data_root_reachable(&custom) {
        return Ok((default_root, Some(DegradedReason::Unreachable)));
    }
    Ok((custom, None))
}

/// 校验前端传来的相对路径：拒绝空、绝对路径、盘符、`..` 穿越、非法字符。
/// 通过后返回规范化的相对路径（`/` 统一为平台分隔符由 join 完成）。
fn validate_rel_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("存储路径为空".into());
    }
    if rel.starts_with('/') || rel.starts_with('\\') || rel.contains(':') {
        return Err(format!("非法的存储路径：{rel}"));
    }
    let path = Path::new(rel);
    let mut has_component = false;
    for comp in path.components() {
        has_component = true;
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s == "." || s == ".." {
                    return Err(format!("非法的存储路径段：{s}"));
                }
                if !s
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
                {
                    return Err(format!("存储路径含非法字符：{s}"));
                }
            }
            Component::CurDir => {
                // `.` 段（含裸 "."）不指向合法存储条目：裸 "." 解析到数据根本身（目录），
                // 读写删都会抛出误导性 IO 错误；统一按非法路径拒绝
                return Err(format!("非法的存储路径：{rel}"));
            }
            _ => return Err(format!("非法的存储路径：{rel}")),
        }
    }
    if !has_component {
        return Err("存储路径为空".into());
    }
    Ok(())
}

/// 相对路径 → 数据根下的绝对路径（含校验）。
/// 自定义数据根不可达（degraded）时返回 Err 而非静默写默认位置——静默回退会
/// 让两处数据分叉且用户无感知（U 盘插回才发现），读写都应显式失败留提示。
pub fn resolve_key_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    validate_rel_path(rel)?;
    let (root, degraded) = resolve_data_root(app)?;
    if let Some(reason) = degraded {
        return Err(reason.message().into());
    }
    let full = root.join(rel);
    // 双保险：Path::starts_with 是逐组件比较（不是字符串前缀）——"data-2" 兄弟
    // 目录、"datax" 等同前缀路径不会被误判为根内
    if !full.starts_with(&root) {
        return Err(format!("存储路径越界：{rel}"));
    }
    Ok(full)
}

/// 原子写：先写同目录临时文件（flush + sync_all 落实到盘），再 rename 覆盖目标。
/// Windows 上 std::fs::rename 已用 MoveFileEx(REPLACE_EXISTING)，可直接覆盖已存在
/// 目标；仅当 rename 因故失败时才回退「删目标 + 重试」——避免「目标已删、新文件
/// 未就位」成为常态窗口（旧实现先删后 rename，崩溃在窗口内会永久丢失旧数据）。
/// tmp 名含进程内单调序号：同 key 并发写不共用一个 tmp（防内容交错/rename 错内容）。
fn atomic_write(target: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = target
        .parent()
        .ok_or_else(|| format!("存储路径缺少父目录：{}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建数据目录：{e}"))?;
    let tmp = parent.join(format!(
        "{}.{}.{}.tmp",
        target
            .file_stem()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_else(|| "dat".into()),
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    // 写 tmp 并强制落盘：断电时最多丢「这次还没写完的内容」，磁盘上不会出现空文件
    let mut file = fs::File::create(&tmp).map_err(|e| format!("无法写入临时文件：{e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("无法写入临时文件：{e}"))?;
    file.flush().map_err(|e| format!("临时文件刷写失败：{e}"))?;
    file.sync_all().map_err(|e| format!("临时文件落盘失败：{e}"))?;
    drop(file);
    if fs::rename(&tmp, target).is_err() {
        // 回退路径：个别文件系统/杀软占用下 rename 覆盖失败，先删目标再试一次。
        // 此窗口内崩溃会丢旧数据（新内容仍完整保留在 tmp 可恢复），概率远低于旧实现的每次写
        if target.exists() {
            fs::remove_file(target).map_err(|e| format!("无法替换旧数据文件：{e}"))?;
        }
        fs::rename(&tmp, target).map_err(|e| {
            // rename 失败时保留 tmp 供诊断，不静默删除
            format!("数据落盘失败（临时文件保留于 {}）：{e}", tmp.display())
        })?;
    }
    Ok(())
}

/// 读一个存储条目：文件不存在返回 None（与「读到空」区分，前端据此回退默认值）。
/// 文件 IO 包 spawn_blocking：不占 tokio worker（数据量大/杀软扫描时防卡其他命令与 UI）。
/// 路径解析含 root.json 读取，同为文件 IO——一并移入阻塞线程（全局不变式：
/// 异步层零文件 IO，评审 storage.rs:229）
#[tauri::command]
pub async fn storage_read(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_key_path(&app, &key)?;
        match fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("读取存储失败（{key}）：{e}")),
        }
    })
    .await
    .map_err(|e| format!("读取任务失败：{e}"))?
}

/// 写命令 IO 段的锁内前置（评审五轮 #1）：拿数据根互斥 → 复查迁移标志 → 锁内重新
/// 解析 key 路径。锁内重解析是防丢失的关键：入口解析发生在迁移开始前（旧根），
/// 若该请求排队到指针切换之后才执行，重解析直接得到新根路径，写落新根；
/// 不重解析则会写进旧根（新根缺失，静默丢失）。返回 Err 表示迁移在途，调用方放弃
fn relocate_safe_path(
    app: &tauri::AppHandle,
    key: &str,
    _guard: &std::sync::MutexGuard<'static, ()>,
) -> Result<PathBuf, String> {
    if RELOCATING.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("数据位置迁移正在进行中，本次写入被安全拦截；迁移完成后请重试".into());
    }
    resolve_key_path(app, key)
}

/// 写一个存储条目（原子写）。前端已把内容序列化为 JSON 字符串，本模块不感知格式。
#[tauri::command]
pub async fn storage_write(app: tauri::AppHandle, key: String, content: String) -> Result<(), String> {
    reject_if_relocating()?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock_data_root();
        let path = relocate_safe_path(&app, &key, &guard)?;
        atomic_write(&path, &content)
    })
    .await
    .map_err(|e| format!("写入任务失败：{e}"))?
}

/// 删除一个存储条目（不存在视为成功，幂等）。迁移写闸：删除也改变数据集——
/// 迁移复制期间删旧根的文件，若已复制进新根，指针切换后会「复活」
#[tauri::command]
pub async fn storage_remove(app: tauri::AppHandle, key: String) -> Result<(), String> {
    reject_if_relocating()?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock_data_root();
        let path = relocate_safe_path(&app, &key, &guard)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除存储失败（{key}）：{e}")),
        }
    })
    .await
    .map_err(|e| format!("删除任务失败：{e}"))?
}

/// 追加一段文本到目标文件尾部（对话日志用）：文件不存在则创建（含父目录）。
/// 与 storage_write 的区别：评审对话是纯追加流（一次评审的所有请求/响应块按时间
/// 序列进同一文件），整文件重写既浪费也破坏「追加」语义。
#[tauri::command]
pub async fn storage_append(
    app: tauri::AppHandle,
    key: String,
    content: String,
) -> Result<(), String> {
    use std::io::Write;
    reject_if_relocating()?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = lock_data_root();
        let path = relocate_safe_path(&app, &key, &guard)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建数据目录：{e}"))?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("无法打开存储文件（{key}）：{e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("写入存储失败（{key}）：{e}"))
    })
    .await
    .map_err(|e| format!("追加任务失败：{e}"))?
}

/// 一级子目录名的语义化校验（storage_remove_dir / storage_list_dirs 共用）：
/// ① 拒绝空名；② Path::components 逐组件判定——裸 "." 解析为数据根本身（remove_dir_all
/// 会清空整个数据根），".." 是穿越，都按组件拒绝；不做子串包含判断，段内连续点
/// （如 "a..b"，validate_rel_path 允许写进）不被误伤，否则写入后无法删除/列举；
/// ③ 拒绝路径分隔符（限定一级子目录）与盘符。
fn validate_dir_name(dir_name: &str) -> Result<(), String> {
    if dir_name.is_empty() {
        return Err("目录名为空".into());
    }
    if dir_name.contains('/') || dir_name.contains('\\') || dir_name.contains(':') {
        return Err(format!("非法的目录名：{dir_name}（仅允许数据根的一级子目录名）"));
    }
    let path = Path::new(dir_name);
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s == "." || s == ".." {
                    return Err(format!("非法的目录名：{dir_name}"));
                }
            }
            // 裸 "."（CurDir）解析到数据根本身、ParentDir 是穿越——remove_dir 语义下
            // 都可能波及数据根内容，与 validate_rel_path 的组件级判定同口径
            Component::CurDir | Component::ParentDir => {
                return Err(format!("非法的目录名：{dir_name}"));
            }
            _ => return Err(format!("非法的目录名：{dir_name}")),
        }
    }
    Ok(())
}

/// 删除数据根下的一个子目录（整棵子树，仓库删除时连评审数据/对话一起清）。
/// 限定「数据根的一级子目录名」，不接受路径分隔符——仓库文件夹只在这一层。
/// degraded 拒绝（同 resolve_key_path 守门）+ 迁移写闸（防删除在新根复活）
#[tauri::command]
pub async fn storage_remove_dir(app: tauri::AppHandle, dir_name: String) -> Result<(), String> {
    reject_if_relocating()?;
    validate_dir_name(&dir_name)?;
    // 目录不存在视为成功（幂等；数据根从未初始化也属此类）。
    // IO 段锁内重新解析数据根：删除改变数据集，与写/删同防丢失/复活口径
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_data_root();
        if RELOCATING.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("数据位置迁移正在进行中，本次删除被安全拦截；迁移完成后请重试".into());
        }
        let (root, degraded) = resolve_data_root(&app)?;
        if let Some(reason) = degraded {
            return Err(reason.message().into());
        }
        let target = root.join(&dir_name);
        match fs::remove_dir_all(&target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除目录失败（{dir_name}）：{e}")),
        }
    })
    .await
    .map_err(|e| format!("删除目录任务失败：{e}"))?
}

/// 列出数据根下某域的一级子目录名（迁移器找旧对话日志的对应仓库时无需全树扫描，
/// 设置页「数据体检」类功能也用它）。返回目录名数组，按字典序。
/// degraded 时返回 Err：空列表会让迁移器误判「没有旧数据」而跳过，造成数据分叉假象。
/// 数据根解析（读 root.json）与 read_dir 同为文件 IO，一并收进阻塞线程
/// （全局不变式：异步层零文件 IO，评审 storage.rs:229）
#[tauri::command]
pub async fn storage_list_dirs(app: tauri::AppHandle, dir_name: String) -> Result<Vec<String>, String> {
    validate_dir_name(&dir_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (root, degraded) = resolve_data_root(&app)?;
        if let Some(reason) = degraded {
            return Err(reason.message().into());
        }
        let target = root.join(&dir_name);
        let mut out: Vec<String> = Vec::new();
        let entries = match fs::read_dir(&target) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(format!("读取目录失败（{dir_name}）：{e}")),
        };
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                out.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| format!("读取目录任务失败：{e}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRootInfo {
    /// 数据根当前生效路径（绝对）
    pub path: String,
    /// 是否处于降级状态（指针指向的位置不可达或指针损坏，当前用默认位置）
    pub degraded: bool,
    /// 降级原因（degraded=true 时携带）：unreachable=指针目标不可达（暂态，恢复后
    /// 重启切回）；pointerCorrupt=root.json 内容损坏（持久态，需删除该文件修复）。
    /// 前端按原因展示不同指引——两者处置方式完全不同，合并成「不可达」会误导
    pub reason: Option<String>,
    /// 是否存在自定义指针（degraded=true 时提示用户「自定义位置不可达」的依据）
    pub has_custom: bool,
    /// 默认数据根路径（设置页展示兜底说明用）
    pub default_path: String,
}

/// 查询数据根状态（设置页「存储」区展示）。root.json 读取与 exists 探测同为文件 IO，
/// 全部收进阻塞线程（全局不变式：异步层零文件 IO，评审 storage.rs:229）
#[tauri::command]
pub async fn data_root_info(app: tauri::AppHandle) -> Result<DataRootInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let default_root = app_data_base(&app)?.join(DATA_ROOT_DIR);
        let pointer_path = root_pointer_path(&app)?;
        let has_custom = pointer_path.exists();
        let (path, degraded) = resolve_data_root(&app)?;
        let reason = degraded.map(|r| match r {
            DegradedReason::Unreachable => "unreachable".to_string(),
            DegradedReason::PointerCorrupt => "pointerCorrupt".to_string(),
        });
        Ok(DataRootInfo {
            path: path.to_string_lossy().to_string(),
            degraded: degraded.is_some(),
            reason,
            has_custom,
            default_path: default_root.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("查询任务失败：{e}"))?
}

/// 打开数据根目录（系统文件管理器）。走 Rust 侧 opener 而非前端 openPath 插件：
/// 免扩 capabilities 权限面（opener:default 不含 open-path），与既有
/// open_ai_log_dir 命令同一模式。create_dir_all 探测为文件 IO，收进阻塞线程
#[tauri::command]
pub async fn data_dir_open(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let app_owned = app.clone(); // 闭包需 'static，opener 调用仍要用外层 app
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let (path, degraded) = resolve_data_root(&app_owned)?;
        // degraded 时打开的是（多半为空的）降级目录，用户会误以为数据丢失——直接报错说明
        if let Some(reason) = degraded {
            return Err(format!("{}（打开数据目录操作已取消）", reason.message()));
        }
        fs::create_dir_all(&path).map(|_| path).map_err(|e| format!("无法创建数据目录：{e}"))
    })
    .await
    .map_err(|e| format!("打开任务失败：{e}"))??;
    app.opener()
        .open_path(opened.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开文件夹：{e}"))
}

/// 更换数据根位置：把现有数据整目录复制到新位置 → 原子更新 root.json 指针。
/// 复制失败不动指针（原地可继续用）；指针更新是最后一步，任一时刻中断都一致。
/// 复制走 spawn_blocking（tokio worker 不被整目录 IO 阻塞，UI/其他命令不受影响），
/// 进行中加互斥（防用户连点触发并发复制）。
/// 可重试状态机（评审 storage.rs:485）：全部检查与 IO 收进锁内顺序执行，复制失败
/// 自动清理本次半成品（复制前锁内已验证目标为空，残留必为本次所产），用户排除
/// 故障（腾出磁盘空间等）后同路径重试畅通，不会被「目标非空」卡死。
#[tauri::command]
pub async fn data_root_set(app: tauri::AppHandle, new_root: String) -> Result<String, String> {
    // 互斥 + 写闸一并由 RELOCATING 承担：CAS 抢到才继续，抢不到说明迁移在途
    if RELOCATING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("数据位置迁移正在进行中，请稍候".into());
    }
    let target = target_of(&new_root);
    let result = data_root_set_inner(&app, new_root, target).await;
    RELOCATING.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

/// 用户输入 → 目标路径：入口统一词法规范化（全局不变式：路径关系判定基于规范化
/// 形态）。`..`/`.` 在此处消除，后续 data_root_set_inner 的嵌套判定据此可靠
fn target_of(new_root: &str) -> PathBuf {
    normalize_components(Path::new(new_root))
}

async fn data_root_set_inner(
    app: &tauri::AppHandle,
    new_root: String,
    target: PathBuf,
) -> Result<String, String> {
    let pointer_path = root_pointer_path(app)?; // 纯路径拼接，无 IO
    let dst = target.clone();
    let app_owned = app.clone(); // AppHandle 廉价克隆：闭包需 'static，&AppHandle 借用搬不进去
    // 全部检查与 IO 收进锁内（全局不变式：异步层零文件 IO + 迁移可重试）：
    // 旧实现把可达性/嵌套/非空检查放在 async 层的锁外——与在途写存在竞态窗口
    // （检查后、锁前在途写可能改变旧根或目标），锁内重做全部检查才看到稳定事实
    tauri::async_runtime::spawn_blocking(move || {
        // guard 命名弃用但必须绑定到语句结束：提前 drop 会让复制与写并发
        let _guard = lock_data_root();
        // ① 锁内重解析 current（读 root.json）：等锁期间在途写可能已改变旧根
        let (current, degraded) = resolve_data_root(&app_owned)?;
        if let Some(reason) = degraded {
            return Err(reason.message().into());
        }
        // ② 目标可达性（is_dir 触盘，移入锁内消除竞态）
        if !data_root_reachable(&dst) {
            return Err(format!("目标位置不可用：{new_root}"));
        }
        // ③ 嵌套判定（纯计算）：两侧都经 normalize_components 规范化（target_of 入口 +
        //    指针回读），`..` 分量已消除，词法 starts_with 判定可靠——
        //    "C:\data\..\data\root\new" 规范化后为 "C:\data\root\new"，正确命中内部判定，
        //    防止自嵌套复制（copy_dir_recursive 把源内部的目标当源条目递归复制，
        //    直至路径超长/磁盘耗尽）
        if dst.starts_with(&current) {
            return Err("新位置不能在当前数据目录内部（含选择当前目录本身）".into());
        }
        if current.starts_with(&dst) {
            return Err("新位置不能是当前数据目录的上级目录".into());
        }
        // ④ 目标必须为空（或不存在）：用户误选已有内容的文件夹时不能静默覆盖同名文件
        if dst.is_dir() {
            let not_empty = fs::read_dir(&dst)
                .map_err(|e| format!("无法读取目标目录：{e}"))?
                .next()
                .is_some();
            if not_empty {
                return Err(format!(
                    "目标目录非空：{new_root}（请选择空文件夹，避免覆盖已有文件）"
                ));
            }
        }
        // ⑤ 复制：失败自动清理本次半成品——④刚在锁内验证过目标为空，此刻目标里的
        //    任何内容都产生于本次复制，remove_dir_all 清理不误删用户文件。
        //    清理尽力而为：清理自身失败不掩盖原始复制错误（重试时④会拦住并如实报非空）
        if current.is_dir() {
            if let Err(e) = copy_dir_recursive(&current, &dst) {
                let cleanup = fs::remove_dir_all(&dst);
                return Err(match cleanup {
                    Ok(()) => format!("复制数据失败：{e}；目标目录残留已自动清理，排除故障后可直接重试"),
                    Err(ce) => format!(
                        "复制数据失败：{e}；且自动清理残留失败（{ce}），请手工清空目标目录后重试"
                    ),
                });
            }
        }
        // ⑥ 建目标目录必须在指针写入之前：失败时指针未动可原地重试；指针原子写是最后一步
        fs::create_dir_all(&dst).map_err(|e| format!("无法创建目标目录：{e}"))?;
        let pointer = RootPointer {
            data_root: dst.to_string_lossy().to_string(),
            v: 1,
        };
        let body = serde_json::to_string_pretty(&pointer)
            .map_err(|e| format!("序列化指针失败：{e}"))?;
        atomic_write(&pointer_path, &body)
    })
    .await
    .map_err(|e| format!("迁移任务失败：{e}"))??;
    Ok(target.to_string_lossy().to_string())
}

/// 递归复制目录（数据迁移用）。已存在的同名文件以源为准覆盖。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rel_path_rejects_traversal() {
        assert!(validate_rel_path("ai/profiles.json").is_ok());
        assert!(validate_rel_path("repos/index.json").is_ok());
        assert!(validate_rel_path("settings/misc.json").is_ok());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../escape.json").is_err());
        assert!(validate_rel_path("ai/../../escape.json").is_err());
        assert!(validate_rel_path("C:/windows/system32").is_err());
        assert!(validate_rel_path("/abs/path.json").is_err());
        assert!(validate_rel_path("a<b.json").is_err());
        // CurDir：裸 "." 拒绝（会解析到数据根本身）。注：内嵌 "a/./b" 在 Windows
        // components() 规范化中不产生 CurDir 分量，等同 "a/b"，无害放行
        assert!(validate_rel_path(".").is_err());
    }

    #[test]
    fn validate_rel_path_allows_spaces_and_dots() {
        assert!(validate_rel_path("repos/local my repo-1/history.json").is_ok());
        assert!(validate_rel_path("repos/local-my-repo-1/results-20261023103000.json").is_ok());
    }

    #[test]
    fn validate_dir_name_semantic_components() {
        // 裸 "." 解析到数据根本身：remove_dir_all 会清空整个数据根，必须拒绝
        assert!(validate_dir_name(".").is_err());
        // 穿越段拒绝
        assert!(validate_dir_name("..").is_err());
        assert!(validate_dir_name("a/../b").is_err());
        // 空名与路径分隔符/盘符拒绝
        assert!(validate_dir_name("").is_err());
        assert!(validate_dir_name("a/b").is_err());
        assert!(validate_dir_name("a\\b").is_err());
        assert!(validate_dir_name("C:").is_err());
        // 段内连续点合法（validate_rel_path 允许写入的目录必须能删能列）：
        // 子串 contains("..") 判定会误伤这类名字
        assert!(validate_dir_name("a..b").is_ok());
        assert!(validate_dir_name("foo...").is_ok());
        // 正常仓库名放行
        assert!(validate_dir_name("remote_github_owner-repo_1a2b3c4d").is_ok());
    }

    #[test]
    fn atomic_write_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("mergehub-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let target = dir.join("sub").join("a.json");
        atomic_write(&target, "{\"v\":1}").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":1}");
        // 覆盖写
        atomic_write(&target, "{\"v\":2}").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":2}");
        // 无残留 tmp
        let leftover: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "leftover tmp files: {leftover:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_dir_recursive_copies_nested() {
        let src = std::env::temp_dir().join(format!("mergehub-cp-src-{}", std::process::id()));
        let dst = std::env::temp_dir().join(format!("mergehub-cp-dst-{}", std::process::id()));
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
        fs::create_dir_all(src.join("repos/r1/conversations")).unwrap();
        fs::write(src.join("root.json"), "{}").unwrap();
        fs::write(src.join("repos/r1/history.json"), "[]").unwrap();
        fs::write(src.join("repos/r1/conversations/a.log"), "x").unwrap();
        copy_dir_recursive(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("root.json")).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(dst.join("repos/r1/conversations/a.log")).unwrap(),
            "x"
        );
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn normalize_components_resolves_dotdot_within_nesting() {
        // 评审 storage.rs:441 主场景：含 .. 的目标词法上绕过嵌套检查——
        // 规范化后正确落在「当前根内部」，data_root_set_inner 的 starts_with 可靠命中
        let current = Path::new("C:\\data\\root");
        let target = normalize_components(Path::new("C:\\data\\..\\data\\root\\new"));
        assert_eq!(target, PathBuf::from("C:\\data\\root\\new"));
        // 规范化后的内部路径被 starts_with 正确识别（修复前词法比较放行）
        assert!(target.starts_with(current));
        // .. 弹到根之上：丢弃（C:\.. 语义上就是 C:\）
        assert_eq!(
            normalize_components(Path::new("C:\\..\\other")),
            PathBuf::from("C:\\other")
        );
        // 内嵌 . 消除、普通路径原样
        assert_eq!(
            normalize_components(Path::new("C:\\a\\.\\b")),
            PathBuf::from("C:\\a\\b")
        );
        assert_eq!(
            normalize_components(Path::new("/opt/data/../data/new")),
            PathBuf::from("/opt/data/new")
        );
    }
}
