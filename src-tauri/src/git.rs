use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows release 构建主进程为 GUI 子系统（windows_subsystem=windows，无控制台），
/// 直接 spawn git 会为每个子进程新建控制台窗口，表现为黑框随刷新/轮询不停闪现；
/// CREATE_NO_WINDOW 抑制子进程窗口创建。开发模式跑在终端里继承现有控制台，本就无此问题。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 统一构造 git 子进程：Windows 下附加 CREATE_NO_WINDOW，其余平台原样返回
fn spawn_git() -> Command {
    // mut 仅供 cfg(windows) 的 creation_flags 使用，非 Windows 下未变更会触发
    // unused_mut 警告，按平台条件豁免
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new("git");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRepoInfo {
    pub root: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
}

/// 仓库远程：name 为远程名，push_url 为推送地址（已剔除内嵌凭证，避免令牌泄露到前端展示）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub push_url: String,
}

/// 工作区单个变更文件的 diff（与远程 PR 的 DiffFile 同构，可复用评审与展示组件）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDiffFile {
    pub path: String,
    /// added | modified | removed | renamed
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    /// 该文件的 unified diff 文本
    pub patch: String,
}

/// status porcelain 解析出的变更条目（仅内部使用）
struct LocalChange {
    path: String,
    status: &'static str,
    /// 重命名/复制时的旧路径
    old_path: Option<String>,
    untracked: bool,
    pending_add: bool,
}

/// 去除 ANSI 转义序列：lefthook 等工具输出常带色彩码，会污染错误信息
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for t in chars.by_ref() {
                if ('\x40'..='\x7e').contains(&t) {
                    break;
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// 统一构造 git 命令失败错误：合并 stderr/stdout、去 ANSI、标注失败子命令，并留痕到终端
fn git_failure_error(step: &str, output: &std::process::Output) -> String {
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let mut merged = String::new();
    if !stderr.trim().is_empty() {
        merged.push_str(stderr.trim());
    }
    if !stdout.trim().is_empty() {
        if !merged.is_empty() {
            merged.push_str("\n--- stdout ---\n");
        }
        merged.push_str(stdout.trim());
    }
    let code = output.status.code().unwrap_or(-1);
    eprintln!("[mergehub:git] {step} 退出码 {code}\n{merged}");
    if merged.is_empty() {
        format!("git {step} 执行失败（退出码 {code}），且无任何输出")
    } else {
        format!("git {step} 执行失败（退出码 {code}）：\n{merged}")
    }
}

/// 执行只读 git 命令：固定参数数组不经 shell，避免注入；core.quotepath=false 保证中文路径原样输出
fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err("路径不存在或不是目录".to_string());
    }
    let output = spawn_git()
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "未找到 git 命令，请确认已安装 Git 并加入 PATH".to_string()
            } else {
                format!("启动 git 失败：{e}")
            }
        })?;
    if !output.status.success() {
        let step = args.first().copied().unwrap_or("git");
        return Err(git_failure_error(step, &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 与 run_git 类似，但容忍退出码 1：`git diff --no-index` 在存在差异时以 1 退出
fn run_git_diff_tolerant(path: &str, args: &[&str]) -> Result<String, String> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err("路径不存在或不是目录".to_string());
    }
    let output = spawn_git()
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "未找到 git 命令，请确认已安装 Git 并加入 PATH".to_string()
            } else {
                format!("启动 git 失败：{e}")
            }
        })?;
    if output.status.code().unwrap_or(0) > 1 {
        let step = args.first().copied().unwrap_or("git");
        return Err(git_failure_error(step, &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 校验目标路径是 git 仓库，并统一返回仓库根目录
fn repo_root(path: &str) -> Result<String, String> {
    let root = run_git(path, &["rev-parse", "--show-toplevel"])?;
    Ok(root.trim().to_string())
}

/// 从 `git status -sb` 首行解析 ahead/behind：形如 `## main...origin/main [ahead 1, behind 2]`
fn parse_ahead_behind(status: &str) -> (u32, u32) {
    let first = status.lines().next().unwrap_or("");
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let (Some(start), Some(end)) = (first.find('['), first.find(']')) {
        if start < end {
            for part in first[start + 1..end].split(',') {
                let part = part.trim();
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.trim().parse().unwrap_or(0);
                }
            }
        }
    }
    (ahead, behind)
}

fn repo_info_impl(path: &str) -> Result<LocalRepoInfo, String> {
    let root = repo_root(path)?;
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let status = run_git(&root, &["status", "-sb"]).unwrap_or_default();
    let (ahead, behind) = parse_ahead_behind(&status);
    Ok(LocalRepoInfo {
        root,
        branch,
        ahead,
        behind,
    })
}

/// 解析 `git status --porcelain=v1 -z` 输出
/// -z 格式以 NUL 分隔，可安全处理含空格/中文等特殊文件名；重命名条目会额外携带一段旧路径
fn parse_status(raw: &str) -> Vec<LocalChange> {
    let mut changes = Vec::new();
    let mut segments = raw.split('\0');
    while let Some(head) = segments.next() {
        if head.len() < 4 {
            // 尾部 NUL 之后的空段或异常段直接跳过
            continue;
        }
        let x = head.as_bytes()[0];
        let y = head.as_bytes()[1];
        let path = head[3..].to_string();
        if path.is_empty() {
            continue;
        }
        // `??` 表示未跟踪的新文件
        if x == b'?' && y == b'?' {
            changes.push(LocalChange {
                path,
                status: "added",
                old_path: None,
                untracked: true,
                pending_add: true,
            });
            continue;
        }
        // 暂存区/工作区双位状态合并，优先级：删除 > 重命名/复制 > 新增 > 其他按修改处理
        let (status, old_path) = if [x, y].contains(&b'D') {
            ("removed", None)
        } else if [x, y].contains(&b'R') || [x, y].contains(&b'C') {
            let old = segments.next().unwrap_or("").trim().to_string();
            let old = if old.is_empty() { None } else { Some(old) };
            ("renamed", old)
        } else if [x, y].contains(&b'A') {
            ("added", None)
        } else {
            ("modified", None)
        };
        changes.push(LocalChange {
            path,
            status,
            old_path,
            untracked: false,
            pending_add: y != b' ',
        });
    }
    changes
}

/// 将 unified diff 文本按 `diff --git ` 切分为独立文件块
fn split_diff_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if line.starts_with("diff --git ") && !current.is_empty() {
            blocks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

/// 剥离 diff 头部的 a/、b/ 前缀与 C 风格引号；/dev/null 表示该侧缺失
fn strip_diff_prefix(raw: &str) -> Option<String> {
    let s = raw.trim();
    let unquoted = if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        s.to_string()
    };
    if unquoted == "/dev/null" {
        return None;
    }
    let stripped = unquoted
        .strip_prefix("b/")
        .or_else(|| unquoted.strip_prefix("a/"))
        .unwrap_or(&unquoted);
    Some(stripped.to_string())
}

/// 从 unified diff 块提取文件路径：优先 +++ 侧新路径，回退 --- 侧旧路径
/// （删除文件的 +++ 为 /dev/null，必须回退到 --- 行才能取到路径）
fn block_path(block: &str) -> Option<String> {
    let mut minus = None;
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("--- ") {
            minus = strip_diff_prefix(rest);
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            if let Some(path) = strip_diff_prefix(rest) {
                return Some(path);
            }
        }
    }
    minus
}

/// 统计 unified diff 块的新增/删除行数（排除 +++/--- 文件头）
fn count_patch(patch: &str) -> (u32, u32) {
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for line in patch.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// 采集工作区全部未提交变更（含暂存与未暂存、未跟踪文件），逐文件产出 unified diff
fn diff_impl(path: &str) -> Result<Vec<LocalDiffFile>, String> {
    let root = repo_root(path)?;
    let status_raw = run_git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let changes = parse_status(&status_raw);
    if changes.is_empty() {
        return Ok(Vec::new());
    }

    // 空仓库（尚无任何提交）没有 HEAD，tracked diff 无从谈起，只保留未跟踪文件
    let has_head = run_git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let mut patch_text = String::new();
    if has_head {
        // `git diff HEAD` 一次性覆盖暂存 + 未暂存的全部 tracked 变更
        patch_text.push_str(&run_git(&root, &["diff", "HEAD"])?);
    }
    for change in changes.iter().filter(|c| c.untracked) {
        // 未跟踪文件与 /dev/null 对比生成"全新文件"diff；退出码 1 表示有差异，属预期
        if let Ok(text) = run_git_diff_tolerant(
            &root,
            &["diff", "--no-index", "--", "/dev/null", &change.path],
        ) {
            patch_text.push_str(&text);
        }
    }

    let mut map: HashMap<String, LocalDiffFile> = HashMap::new();
    for block in split_diff_blocks(&patch_text) {
        let Some(file_path) = block_path(&block) else {
            continue;
        };
        let (additions, deletions) = count_patch(&block);
        let status = changes
            .iter()
            .find(|c| c.path == file_path || c.old_path.as_deref() == Some(file_path.as_str()))
            .map(|c| c.status.to_string())
            .unwrap_or_else(|| "modified".to_string());
        map.insert(
            file_path.clone(),
            LocalDiffFile {
                path: file_path,
                status,
                additions,
                deletions,
                patch: block,
            },
        );
    }

    let mut files: Vec<LocalDiffFile> = Vec::with_capacity(changes.len());
    let mut missing: Vec<&LocalChange> = Vec::new();
    for change in &changes {
        match map.remove(&change.path) {
            Some(file) => files.push(file),
            None => missing.push(change),
        }
    }
    // 状态里有但 diff 解析不出的条目（如二进制文件），兜底为占位 patch，保证列表完整
    for change in missing {
        files.push(LocalDiffFile {
            path: change.path.clone(),
            status: change.status.to_string(),
            additions: 0,
            deletions: 0,
            patch: "二进制文件或无法解析的差异".to_string(),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// 提交结果：新提交短 SHA 与因无相对 HEAD 变化而被跳过的勾选文件清单
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub sha: String,
    pub skipped: Vec<String>,
}

/// 暂存选中文件并提交，返回新提交的短 SHA
fn commit_impl(path: &str, files: &[String], message: &str) -> Result<CommitOutcome, String> {
    if files.is_empty() {
        return Err("请至少勾选一个变更文件".to_string());
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("请填写提交说明".to_string());
    }
    let root = repo_root(path)?;
    let status_raw = run_git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let changes = parse_status(&status_raw);
    let pending: HashSet<&str> = changes
        .iter()
        .filter(|c| c.pending_add)
        .map(|c| c.path.as_str())
        .collect();
    let to_add: Vec<&str> = files
        .iter()
        .map(|s| s.as_str())
        .filter(|f| pending.contains(f))
        .collect();
    // 不在 status 中的勾选文件相对 HEAD 无任何变化（已被提交/无差异/竞态消失），
    // add 本会是 no-op 或 pathspec 错误；跳过它们但必须显式反馈，禁止静默
    let known: HashSet<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    let skipped: Vec<String> = files
        .iter()
        .filter(|f| !known.contains(f.as_str()))
        .cloned()
        .collect();
    if skipped.len() == files.len() {
        // 全部勾选文件均无变化时继续 commit 会把暂存区既有的未勾选内容打包提交，必须阻断
        return Err(
            "勾选的文件均无待提交变化（可能已被提交或与最新代码一致），未执行提交".to_string(),
        );
    }
    if !to_add.is_empty() {
        let mut add_args: Vec<&str> = vec!["add", "--"];
        add_args.extend(to_add);
        run_git(&root, &add_args)?;
    }
    run_git(&root, &["commit", "-m", message])?;
    let sha = run_git(&root, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string();
    Ok(CommitOutcome { sha, skipped })
}

/// 读取本地仓库概要：仓库根、当前分支、领先/落后远程的提交数
#[tauri::command]
pub async fn git_repo_info(path: String) -> Result<LocalRepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || repo_info_impl(&path))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 读取本地工作区变更文件列表（含变更、新增、删除、重命名）
#[tauri::command]
pub async fn git_diff(path: String) -> Result<Vec<LocalDiffFile>, String> {
    tauri::async_runtime::spawn_blocking(move || diff_impl(&path))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 提交选中的变更文件（先 add 后 commit），返回新提交短 SHA 与被跳过的无变化勾选文件清单
#[tauri::command]
pub async fn git_commit(
    path: String,
    files: Vec<String>,
    message: String,
) -> Result<CommitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || commit_impl(&path, &files, &message))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 本地分支：name 为分支名，current 标记当前所在分支
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub current: bool,
}

/// 列出本地分支：`%(HEAD)` 首字符为 `*` 即当前所在分支
fn branches_impl(path: &str) -> Result<Vec<LocalBranch>, String> {
    let root = repo_root(path)?;
    let out = run_git(
        &root,
        &["for-each-ref", "--format=%(HEAD)%(refname:short)", "refs/heads"],
    )?;
    Ok(out
        .lines()
        .filter(|l| l.trim().len() > 1)
        .map(|l| LocalBranch {
            current: l.starts_with('*'),
            name: l[1..].trim().to_string(),
        })
        .collect())
}

/// 切换到指定本地分支；工作区有未提交变更时由 git 裁决：能安全切换则带着变更切换，否则拒绝
fn checkout_impl(path: &str, branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("请选择要切换的分支".to_string());
    }
    let root = repo_root(path)?;
    run_git(&root, &["checkout", branch])?;
    Ok(format!("已切换到分支 {branch}"))
}

/// 列出本地分支（标记当前所在分支）
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<LocalBranch>, String> {
    tauri::async_runtime::spawn_blocking(move || branches_impl(&path))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 切换当前分支（提交与比对随之对准新分支）
#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || checkout_impl(&path, &branch))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 校验推送分支名：拒绝空名、`-` 开头（防被 git 解析为选项）与含空白字符的名称
fn validate_push_branch(name: &str, label: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("请填写要推送到的{label}分支名"));
    }
    if name.starts_with('-') {
        return Err(format!("{label}分支名不能以 - 开头：{name}"));
    }
    if name.chars().any(char::is_whitespace) {
        return Err(format!("{label}分支名不能包含空白字符：{name}"));
    }
    Ok(())
}

/// 校验远程仓库名：规则与分支名一致（空名 / `-` 开头 / 空白字符均拒绝），文案区分远程维度
fn validate_push_remote(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("请指定要推送的远程仓库名".to_string());
    }
    if name.starts_with('-') {
        return Err(format!("远程仓库名不能以 - 开头：{name}"));
    }
    if name.chars().any(char::is_whitespace) {
        return Err(format!("远程仓库名不能包含空白字符：{name}"));
    }
    Ok(())
}

/// 推送本地分支到指定远程：refspec 硬指定 local:remote，推送目标与跟踪配置（upstream / push.default）完全解耦，
/// 杜绝"本地分支被推到远端其他分支"；-u 顺带把跟踪关系修正为目标分支；GIT_TERMINAL_PROMPT=0 保证无凭证时立即失败而非挂起
fn push_impl(
    path: &str,
    remote_name: &str,
    local_branch: &str,
    remote_branch: &str,
) -> Result<String, String> {
    let remote_name = remote_name.trim();
    let local = local_branch.trim();
    let remote = remote_branch.trim();
    if local == "HEAD" {
        return Err("当前处于游离 HEAD 状态（未位于任何分支），请先切换分支再推送".to_string());
    }
    validate_push_remote(remote_name)?;
    validate_push_branch(local, "本地")?;
    validate_push_branch(remote, "远端")?;
    let root = repo_root(path)?;
    let output = spawn_git()
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-C")
        .arg(&root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["push", "-u", remote_name, &format!("{local}:{remote}")])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "未找到 git 命令，请确认已安装 Git 并加入 PATH".to_string()
            } else {
                format!("启动 git 失败：{e}")
            }
        })?;
    if !output.status.success() {
        let mut err = git_failure_error("push", &output);
        let raw = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        // 非 fast-forward 拒推：透传 git 原文并附引导文案，不内置 pull、不强制推送
        if raw.contains("[rejected]") || raw.contains("non-fast-forward") {
            err.push_str(
                "\n\n推送被拒绝：远端分支包含本地没有的提交。请在终端执行 git pull --rebase 同步后再推送（本工具不内置拉取与强制推送）。",
            );
        }
        return Err(err);
    }
    if remote == local {
        Ok(format!("已推送至 {remote_name}/{remote}"))
    } else {
        Ok(format!("已推送至 {remote_name}/{remote}（本地 {local} → 远端 {remote}）"))
    }
}

/// 推送本地分支到指定远程的指定分支（refspec 硬指定，不受跟踪配置影响；远端无该分支时自动创建）
#[tauri::command]
pub async fn git_push(
    path: String,
    remote: String,
    local_branch: String,
    remote_branch: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        push_impl(&path, &remote, &local_branch, &remote_branch)
    })
    .await
    .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 剔除远程 URL 中内嵌的凭证段（scheme://user:token@host/... → scheme://host/...），避免令牌泄露到前端展示；
/// authority 终止于 '/'、'?' 或 '#'，三者皆无时整段视为 authority（覆盖 scheme://user:token@host 无路径形态）
fn sanitize_remote_url(url: &str) -> String {
    if let Some(scheme_end) = url.find("://") {
        let rest = &url[scheme_end + 3..];
        let auth_end = rest
            .find(|c| c == '/' || c == '?' || c == '#')
            .unwrap_or(rest.len());
        let authority = &rest[..auth_end];
        if let Some(at) = authority.rfind('@') {
            return format!(
                "{}://{}{}",
                &url[..scheme_end],
                &authority[at + 1..],
                &rest[auth_end..]
            );
        }
    }
    url.to_string()
}

/// 列出仓库全部远程：解析 `git remote -v`，按远程名聚合并优先取 push 地址（缺失时回落 fetch 地址）
fn remotes_impl(path: &str) -> Result<Vec<GitRemote>, String> {
    let root = repo_root(path)?;
    let out = run_git(&root, &["remote", "-v"])?;
    // (name, push_url, fetch_url)：按 git remote -v 输出顺序保持，同名行聚合
    let mut remotes: Vec<(String, Option<String>, Option<String>)> = Vec::new();
    for line in out.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let Some((url, kind)) = rest.rsplit_once(" (") else {
            continue;
        };
        let kind = kind.trim_end_matches(')');
        if let Some(entry) = remotes.iter_mut().find(|(n, _, _)| n == name) {
            if kind == "push" {
                entry.1 = Some(url.to_string());
            } else if entry.2.is_none() {
                entry.2 = Some(url.to_string());
            }
        } else {
            remotes.push((
                name.to_string(),
                (kind == "push").then(|| url.to_string()),
                (kind != "push").then(|| url.to_string()),
            ));
        }
    }
    Ok(remotes
        .into_iter()
        .map(|(name, push, fetch)| GitRemote {
            name,
            push_url: sanitize_remote_url(push.or(fetch).as_deref().unwrap_or("")),
        })
        .collect())
}

/// 列出仓库全部远程（名称 + 推送地址，地址已剔除内嵌凭证）
#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<GitRemote>, String> {
    tauri::async_runtime::spawn_blocking(move || remotes_impl(&path))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}

/// 单文件读取上限（1MB）：复核只关心文本源码，超过上限直接拒绝
const MAX_READ_FILE_BYTES: u64 = 1024 * 1024;

/// 读取仓库内指定文件的全文（AI 第二遍复核用）：先定位仓库根，
/// 再经 canonicalize 归一化校验目标路径未越出仓库，最后按 UTF-8 读取
fn read_local_file_impl(path: &str, file_path: &str) -> Result<String, String> {
    let root = repo_root(path)?;
    let root_canonical = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("解析仓库根路径失败：{e}"))?;
    let target = Path::new(&root).join(file_path);
    let target_canonical = target
        .canonicalize()
        .map_err(|_| format!("文件不存在或无法访问：{file_path}"))?;
    if !target_canonical.starts_with(&root_canonical) {
        return Err(format!("文件路径越出仓库范围：{file_path}"));
    }
    if !target_canonical.is_file() {
        return Err(format!("目标不是常规文件：{file_path}"));
    }
    let size = target_canonical
        .metadata()
        .map_err(|e| format!("读取文件信息失败：{e}"))?
        .len();
    if size > MAX_READ_FILE_BYTES {
        return Err(format!(
            "文件过大（{} 字节，上限 {} 字节）：{}",
            size, MAX_READ_FILE_BYTES, file_path
        ));
    }
    std::fs::read_to_string(&target_canonical)
        .map_err(|e| format!("读取文件失败（可能为二进制或非 UTF-8 编码）：{e}"))
}

/// 读取仓库内文件全文（供 AI 两遍评审的第二遍取证；路径禁止越出仓库根）
#[tauri::command]
pub async fn read_local_file(path: String, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_local_file_impl(&path, &file_path))
        .await
        .map_err(|e| format!("任务执行失败：{e}"))?
}
