import { invoke } from '@tauri-apps/api/core'
import type { CommitOutcome, GitRemote, LocalBranch, LocalDiffFile, LocalRepoInfo } from '../../types/local'

/** 读取本地仓库概要：仓库根、当前分支、领先/落后远程的提交数 */
export function getRepoInfo(path: string): Promise<LocalRepoInfo> {
  return invoke('git_repo_info', { path })
}

/** 读取工作区变更文件列表（含变更、新增、删除、重命名，逐文件 unified diff） */
export function getLocalDiff(path: string): Promise<LocalDiffFile[]> {
  return invoke('git_diff', { path })
}

/** 提交选中的变更文件（先 add 后 commit），返回新提交短 SHA 与因相对 HEAD 已无变化被跳过的勾选文件清单 */
export function commitChanges(path: string, files: string[], message: string): Promise<CommitOutcome> {
  return invoke('git_commit', { path, files, message })
}

/** 列出本地分支（标记当前所在分支） */
export function listBranches(path: string): Promise<LocalBranch[]> {
  return invoke('git_branches', { path })
}

/** 切换当前分支（提交与比对随之对准新分支） */
export function checkoutBranch(path: string, branch: string): Promise<string> {
  return invoke('git_checkout', { path, branch })
}

/** 推送本地分支到指定远程的指定分支（refspec 硬指定，不受跟踪配置影响；-u 顺带修正跟踪关系；远端无该分支时自动创建） */
export function pushCommits(path: string, remote: string, localBranch: string, remoteBranch: string): Promise<string> {
  return invoke('git_push', { path, remote, localBranch, remoteBranch })
}

/** 列出仓库全部远程（名称 + 推送地址，地址已剔除内嵌凭证） */
export function listRemotes(path: string): Promise<GitRemote[]> {
  return invoke('git_remotes', { path })
}

/** 读取仓库内指定文件的全文（AI 两遍评审的第二遍取证用；路径禁止越出仓库根） */
export function readLocalFile(path: string, filePath: string): Promise<string> {
  return invoke('read_local_file', { path, filePath })
}
