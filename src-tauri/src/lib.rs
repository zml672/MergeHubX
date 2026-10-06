mod commands;
mod git;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
