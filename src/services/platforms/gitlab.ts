import type {
  DiffFileStatus,
  MergeMethod,
  PlatformAccount,
  PullRequestComment,
  PullRequestDetail,
  PullRequestQuery,
  PullRequestSummary,
} from '../../types/platform'
import { httpRequest } from '../http'
import type { PlatformProvider } from './types'
import {
  assertOk,
  compareByCreatedAt,
  countDiffLines,
  decodeBase64Text,
  fetchAllComments,
  MAX_REMOTE_FILE_BASE64_CHARS,
  parseCreatedAt,
  parseJsonSafe,
  warnCommentTruncation,
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
  repo: string,
  headers: Record<string, string> | undefined,
): Promise<GitlabDiff[]> {
  const endpoints: { url: string; parse: (body: string) => GitlabDiff[] }[] = [
    {
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/diffs?per_page=100`,
      parse: (body) =>
        parseJsonSafe<GitlabDiff[]>(
          body,
          'GitLab',
          `merge_requests/${number}/diffs`,
        ),
    },
    {
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/diffs?per_page=100&access_raw_diffs=true`,
      parse: (body) =>
        parseJsonSafe<GitlabDiff[]>(
          body,
          'GitLab',
          `merge_requests/${number}/diffs?access_raw_diffs=true`,
        ),
    },
    {
      url: `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/changes`,
      parse: (body) =>
        parseJsonSafe<GitlabChangesResponse>(
          body,
          'GitLab',
          `merge_requests/${number}/changes`,
        ).changes ?? [],
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
        // 护栏触发可见化（族B 收口，同 #34 口径）：耗尽页数仍有下一页 = 可能截断，
        // 静默退出会让「评审漏了文件」无从归因；fetch 失败在上层有 endpoints 重试兜底，
        // 截断只告警不抛错（diff 拉取本身属尽力而为，漏检由评审报告的文件数体现）
        if (page === MAX_DIFF_PAGES) {
          console.warn(
            `[gitlab] ${repo}#${number} diff 翻页达护栏上限 ${MAX_DIFF_PAGES} 页，列表可能被截断，评审将漏检超限部分的变更文件`,
          )
        }
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
    const user = parseJsonSafe<{ username?: string }>(res.body, 'GitLab', 'user')
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
    const mrs = parseJsonSafe<GitlabMergeRequest[]>(res.body, 'GitLab', 'merge_requests 列表')
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
      mr = parseJsonSafe<GitlabMergeRequestDetail>(
        mrRes.body,
        'GitLab',
        `merge_requests/${number} 详情`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`获取 MR 详情失败：${message}`)
    }
    const rawDiffs = await fetchMrDiffFiles(
      base,
      projectPath,
      number,
      repo,
      headers,
    )
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
    const payload = parseJsonSafe<{ content?: string | null; encoding?: string }>(
      res.body,
      'GitLab',
      `repository/files/${path}`,
    )
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

  // GitLab 的 MR 评论 = notes：系统注记（assigned to / approved 等状态流水）靠 system:true
  // 标识，其 type 同样为 null（评审 #26 纠偏：type 仅区分 DiffNote/DiscussionNote 等讨论
  // 形态，按 type===null 过滤挡不住系统注记反而错杀行内评论）；故按 system!==true 过滤，
  // 行内评论保留——检索锚点匹配不受影响。sort=asc 拉正序；X-Next-Page 响应头翻页拉全量
  // （评审 #32：sort=asc 下最新评论排在末页，只取首页必漏检 → 幂等退化重复发布）。
  // 循环骨架/护栏/告警统一走 utils.fetchAllComments（评审 #59），头驱动语义由 fetchPage
  // 返回值表达：响应头无下一页 = done；有下一页 = hasNext
  async listPullRequestComments(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<{ comments: PullRequestComment[]; truncated: boolean }> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const endpoint = `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/notes?per_page=100&sort=asc&order_by=created_at`
    const { items, truncated } = await fetchAllComments<{
      id: number
      body: string
      system: boolean
      created_at?: string
    }>({
      fetchPage: async (page) => {
        const url = page === 1 ? endpoint : `${endpoint}&page=${page}`
        const res = await httpRequest({
          url,
          headers: account.token ? { 'PRIVATE-TOKEN': account.token } : undefined,
        })
        assertOk(res.status, res.body, 'GitLab')
        const pageItems = parseJsonSafe<
          {
            id: number
            body: string
            system: boolean
            created_at?: string
          }[]
        >(res.body, 'GitLab', url)
        const hasNext = headerValue(res.headers, 'x-next-page') !== ''
        return { items: pageItems, done: !hasNext, hasNext }
      },
      onTruncated: (fetchedCount) => warnCommentTruncation('gitlab', repo, number, fetchedCount),
    })
    // 系统注记（system:true）滤除
    const comments = items
      .filter((n) => n.system !== true)
      .map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: parseCreatedAt(n.created_at),
      }))
    // created_at 升序排序兜底（评审 #41）：服务端 order_by=created_at&sort=asc 之上再按
    // 时间戳本地归一（双保险）；缺失/非法时间戳视作最旧排最前（评审 #48）
    comments.sort(compareByCreatedAt)
    return { comments, truncated }
  },

  async upsertPullRequestComment(
    account: PlatformAccount,
    repo: string,
    number: number,
    commentId: number | null,
    body: string,
  ): Promise<number> {
    const base = (account.baseUrl || GITLAB_API).replace(/\/+$/, '')
    const projectPath = encodeURIComponent(repo)
    const res = await httpRequest({
      url:
        commentId === null
          ? `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/notes`
          : `${base}/api/v4/projects/${projectPath}/merge_requests/${number}/notes/${commentId}`,
      method: commentId === null ? 'POST' : 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(account.token ? { 'PRIVATE-TOKEN': account.token } : {}),
      },
      body: JSON.stringify({ body }),
    })
    assertOk(res.status, res.body, 'GitLab')
    return parseJsonSafe<{ id: number }>(
      res.body,
      'GitLab',
      commentId === null ? 'merge_requests notes 发布' : `merge_requests/${number}/notes/${commentId} 更新`,
    ).id
  },
}
