export type Platform = 'github' | 'gitlab' | 'gitee'

export const PLATFORM_LABELS: Record<Platform, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitee: 'Gitee',
}

export const PLATFORM_TAG_COLORS: Record<Platform, string> = {
  github: 'geekblue',
  gitlab: 'volcano',
  gitee: 'green',
}

export interface PlatformAccount {
  platform: Platform
  token: string
  baseUrl: string
}

export type PrState = 'open' | 'all'

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: '普通合并',
  squash: '压缩合并',
  rebase: '变基合并',
}

export interface PullRequestQuery {
  repo: string
  state: PrState
}

export interface PullRequestSummary {
  key: string
  platform: Platform
  repo: string
  number: number
  title: string
  author: string
  state: string
  sourceBranch: string
  targetBranch: string
  fromFork: boolean
  createdAt: string
  updatedAt: string
  url: string
}

export type DiffFileStatus = 'added' | 'modified' | 'removed' | 'renamed'

export interface DiffFile {
  path: string
  status: DiffFileStatus
  additions: number
  deletions: number
  patch: string
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string
  additions: number
  deletions: number
  changedFiles: number
  files: DiffFile[]
}

export const PLATFORMS: Platform[] = ['github', 'gitlab', 'gitee']
