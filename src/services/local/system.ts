import { invoke } from '@tauri-apps/api/core'

/** 用系统文件管理器打开指定文件夹（Rust 侧调用 opener，不受前端 ACL 权限限制） */
export function openInFileManager(path: string): Promise<void> {
  return invoke('open_local_folder', { path })
}
