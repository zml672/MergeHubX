import type {
  DiffFileStatus,
  MergeMethod,
  PlatformAccount,
  PullRequestDetail,
  PullRequestQuery,
  PullRequestSummary,
} from '../../types/platform'
import { httpRequest } from '../http'
import type { PlatformProvider } from './types'
import {
  assertOk,
  countDiffLines,
  decodeBase64Text,
  MAX_REMOTE_FILE_BASE64_CHARS,
} from './utils'

const GITLAB_API = 'https://gitlab.com'

interface GitlabMergeRequest {
  iid: number
  title: string
  state: string
  web_url: string
  author: { username: string }
  created_at: string
  updated_at: string
  source_branch: string
  target_branch: string
  source_project_id: number
  target_project_id: number
}

interface GitlabMergeRequestDetail extends GitlabMergeRequest {
  description: string | null
}

interface GitlabDiff {
  old_path: string
  new_path: string
  diff: string
  new_file: boolean
  deleted_file: boolean
  renamed_file: boolean
}

interface GitlabChangesResponse {
  changes?: GitlabDiff[]
}

const MAX_DIFF_PAGES = 10

function headerValue(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  return headers[lower] ?? headers[name] ?? ''
}

/**
 * 获取 MR 的 diff 文件列表，带数据源回退与翻页。
 * 私有化实例上 /diffs 端点收集大变更时常见 500（Gitaly 超时），依次回退：
 * ① /diffs（读 diff 缓存）→ ② /diffs?access_raw_diffs=true（直读仓库原始 diff）
 * → ③ /changes（整单返回兜底）。仅 5xx/网络错误才回退，4xx（权限/不存在）直接抛出。
 */
async function fetchMrDiffFiles(
  base: string,
  projectPath: string,
  number: number,
  headers: Record<string, string> | undefined,
): Promise<GitlabDiff[]> {
  const endpoints: { url: string; parse: (body: string) => GitlabDiff[] }[] = [
    {
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/diffs?per_page=100`,
      parse: (body) => JSON.parse(body) as GitlabDiff[],
    },
    {
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/diffs?per_page=100&access_raw_diffs=true`,
      parse: (body) => JSON.parse(body) as GitlabDiff[],
    },
    {
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/changes`,
      parse: (body) => (JSON.parse(body) as GitlabChangesResponse).changes ?? [],
    },
  ]
  const cacheKey = `${base}|${projectPath}`
  const start = preferredDiffEndpoint.get(cacheKey) ?? 0
  let lastError: Error = new Error('未知错误')
  for (let i = start; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i]
    try {
      const files: GitlabDiff[] = []
      let url = endpoint.url
      for (let page = 1; page <= MAX_DIFF_PAGES; page += 1) {
        const res = await httpRequest({ url, headers })
        assertOk(res.status, res.body, 'GitLab')
        files.push(...endpoint.parse(res.body))
        const next = headerValue(res.headers, 'x-next-page')
        if (!next) break
        url = `${endpoint.url}&page=${next}`
      }
      preferredDiffEndpoint.set(cacheKey, i)
      return files
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (/GitLab API 4\d\d/.test(lastError.message)) throw lastError
    }
  }
  throw new Error(
    `获取 MR diff 失败（已依次尝试 diffs、原始 diffs、changes 接口）：${lastError.message}`,
  )
}

/** 记录每个项目最近一次成功的 diff 数据源，避免每次点开都重试已知的 500 路径 */
const preferredDiffEndpoint = new Map<string, number>()

function diffStatus(d: GitlabDiff): DiffFileStatus {
  if (d.new_file) return 'added'
  if (d.deleted_file) return 'removed'
  if (d.renamed_file) return 'renamed'
  return 'modified'
}

export const gitlabProvider: PlatformProvider = {
  platform: 'gitlab',
  defaultBaseUrl: GITLAB_API,

  async fetchAccountUser(account: PlatformAccount): Promise<string> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url: `${base}/api/v4/user`,
      headers: account.token ? { 'PRIVATE-TOKEN': account.token } : undefined,
    })
    assertOk(res.status, res.body, 'GitLab')
    const user = JSON.parse(res.body) as { username?: string }
    return user.username ?? ''
  },

  async listPullRequests(
    account: PlatformAccount,
    query: PullRequestQuery,
  ): Promise<PullRequestSummary[]> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(query.repo)
    const state = query.state === 'open' ? 'opened' : 'all'
    const res = await httpRequest({
      url: `${base}/api/v4/projects/${projectPath}/merge_requests?state=${state}&per_page=50`,
      headers: account.token ? { 'PRIVATE-TOKEN': account.token } : undefined,
    })
    assertOk(res.status, res.body, 'GitLab')
    const mrs = JSON.parse(res.body) as GitlabMergeRequest[]
    return mrs.map((mr) => ({
      key: `gitlab-${query.repo}#${mr.iid}`,
      platform: 'gitlab',
      repo: query.repo,
      number: mr.iid,
      title: mr.title,
      author: mr.author.username,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      fromFork: mr.source_project_id !== mr.target_project_id,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      url: mr.web_url,
    }))
  },

  async getPullRequestDetail(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<PullRequestDetail> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const headers = account.token
      ? { 'PRIVATE-TOKEN': account.token }
      : undefined
    let mr: GitlabMergeRequestDetail
    try {
      const mrRes = await httpRequest({
        url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}`,
        headers,
      })
      assertOk(mrRes.status, mrRes.body, 'GitLab')
      mr = JSON.parse(mrRes.body) as GitlabMergeRequestDetail
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`获取 MR 详情失败：${message}`)
    }
    const rawDiffs = await fetchMrDiffFiles(base, projectPath, number, headers)
    const files = rawDiffs.map((d) => {
      const { additions, deletions } = countDiffLines(d.diff)
      return {
        path: d.old_path === d.new_path ? d.new_path : `${d.old_path} → ${d.new_path}`,
        status: diffStatus(d),
        additions,
        deletions,
        patch: d.diff,
      }
    })
    return {
      key: `gitlab-${repo}#${mr.iid}`,
      platform: 'gitlab',
      repo,
      number: mr.iid,
      title: mr.title,
      author: mr.author.username,
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      fromFork: mr.source_project_id !== mr.target_project_id,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      url: mr.web_url,
      body: mr.description ?? '',
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      changedFiles: files.length,
      files,
    }
  },

  async approvePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const res = await httpRequest({
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/approve`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(account.token ? { 'PRIVATE-TOKEN': account.token } : {}),
      },
    })
    assertOk(res.status, res.body, 'GitLab')
  },

  async mergePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    if (method === 'rebase') {
      throw new Error('GitLab 不支持合并时变基，请改用普通合并或压缩合并')
    }
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const body: Record<string, unknown> = {}
    if (method === 'squash') body.squash = true
    const res = await httpRequest({
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/merge`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(account.token ? { 'PRIVATE-TOKEN': account.token } : {}),
      },
      body: JSON.stringify(body),
    })
    assertOk(res.status, res.body, 'GitLab')
  },

  async closePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const res = await httpRequest({
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(account.token ? { 'PRIVATE-TOKEN': account.token } : {}),
      },
      body: JSON.stringify({ state_event: 'close' }),
    })
    assertOk(res.status, res.body, 'GitLab')
  },

  async fetchFileContent(
    account: PlatformAccount,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const encodedPath = encodeURIComponent(path).replace(/%2F/gi, '/')
    const res = await httpRequest({
      url: `${base}/api/v4/projects/${projectPath}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      headers: account.token ? { 'PRIVATE-TOKEN': account.token } : undefined,
    })
    assertOk(res.status, res.body, 'GitLab')
    const payload = JSON.parse(res.body) as {
      content?: string | null
      encoding?: string
    }
    // 仅校验编码类型：空文件的 content 为空串是合法返回，应解码为空文本而非误判「内容不可用」（否则该文件被静默跳过复核）
    if (payload.encoding !== 'base64') {
      throw new Error(`GitLab 文件内容不可用：${path}`)
    }
    const content = payload.content ?? ''
    // 解码前拦截超大文件：与本地 read_local_file 的 1MB 上限对齐，避免解码内存开销与超长全文进入复核提示词的 token 开销
    if (content.length > MAX_REMOTE_FILE_BASE64_CHARS) {
      throw new Error(
        `GitLab 文件过大（base64 ${content.length} 字符，上限 ${MAX_REMOTE_FILE_BASE64_CHARS} 字符）：${path}`,
      )
    }
    return decodeBase64Text(content)
  },
}
