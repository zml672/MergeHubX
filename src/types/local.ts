import type { DiffFileStatus } from './platform'

/** 本地仓库概要：仓库根目录、当前分支与远程同步状态 */
export interface LocalRepoInfo {
  root: string
  branch: string
  ahead: number
  behind: number
}

/** 本地分支：current 标记当前所在分支 */
export interface LocalBranch {
  name: string
  current: boolean
}

/** 工作区变更状态（与远程 PR 的 DiffFileStatus 同构） */
export type LocalChangeStatus = DiffFileStatus

/** 工作区单个变更文件的 diff（与远程 PR 的 DiffFile 同构，可直接复用 AI 评审与展示组件） */
export interface LocalDiffFile {
  path: string
  status: LocalChangeStatus
  additions: number
  deletions: number
  /** 该文件的 unified diff 文本 */
  patch: string
}

/** 仓库远程：name 为远程名，pushUrl 为推送地址（已剔除内嵌凭证，避免令牌泄露到界面） */
export interface GitRemote {
  name: string
  pushUrl: string
}

/** 提交结果：新提交的短 SHA，以及因相对 HEAD 已无变化（可能已被提交或与最新代码一致）而被跳过未 add 的勾选文件清单 */
export interface CommitOutcome {
  sha: string
  skipped: string[]
}
