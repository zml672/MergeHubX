import type {
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
  decodeBase64Text,
  fetchAllComments,
  mapDiffStatus,
  MAX_REMOTE_FILE_BASE64_CHARS,
  parseCreatedAt,
  parseJsonSafe,
  splitRepo,
  warnCommentTruncation,
} from './utils'

const GITHUB_API = 'https://api.github.com'

const MAX_FILE_PAGES = 30

interface GithubPull {
  number: number
  title: string
  state: string
  html_url: string
  user: { login: string } | null
  created_at: string
  updated_at: string
  head: { ref: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } }
}

interface GithubPullDetail extends GithubPull {
  body: string | null
  additions: number
  deletions: number
  changed_files: number
}

interface GithubFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

export const githubProvider: PlatformProvider = {
  platform: 'github',
  defaultBaseUrl: GITHUB_API,

  async fetchAccountUser(account: PlatformAccount): Promise<string> {
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url: `${base}/user`,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
    })
    assertOk(res.status, res.body, 'GitHub')
    const user = parseJsonSafe<{ login?: string }>(res.body, 'GitHub', 'user')
    return user.login ?? ''
  },

  async listPullRequests(
    account: PlatformAccount,
    query: PullRequestQuery,
  ): Promise<PullRequestSummary[]> {
    const [owner, repo] = splitRepo(query.repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url: `${base}/repos/${owner}/${repo}/pulls?state=${query.state}&per_page=50`,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
    })
    assertOk(res.status, res.body, 'GitHub')
    const pulls = parseJsonSafe<GithubPull[]>(res.body, 'GitHub', 'pulls 列表')
    return pulls.map((p) => ({
      key: `github-${p.base.repo?.full_name ?? query.repo}#${p.number}`,
      platform: 'github',
      repo: p.base.repo?.full_name ?? query.repo,
      number: p.number,
      title: p.title,
      author: p.user?.login ?? 'unknown',
      state: p.state,
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      fromFork:
        p.head.repo != null && p.head.repo.full_name !== p.base.repo.full_name,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      url: p.html_url,
    }))
  },

  async getPullRequestDetail(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<PullRequestDetail> {
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
    }
    const pullRes = await httpRequest({
      url: `${base}/repos/${owner}/${name}/pulls/${number}`,
      headers,
    })
    assertOk(pullRes.status, pullRes.body, 'GitHub')
    const p = parseJsonSafe<GithubPullDetail>(
      pullRes.body,
      'GitHub',
      `pulls/${number} 详情`,
    )
    const rawFiles: GithubFile[] = []
    let page = 1
    while (page <= MAX_FILE_PAGES) {
      const filesRes = await httpRequest({
        url: `${base}/repos/${owner}/${name}/pulls/${number}/files?per_page=100&page=${page}`,
        headers,
      })
      assertOk(filesRes.status, filesRes.body, 'GitHub')
      const chunk = parseJsonSafe<GithubFile[]>(
        filesRes.body,
        'GitHub',
        `pulls/${number}/files 第 ${page} 页`,
      )
      rawFiles.push(...chunk)
      if (chunk.length < 100) break
      page += 1
    }
    console.debug(
      `[github] ${repo}#${number} 文件列表拉取 ${Math.min(page, MAX_FILE_PAGES)} 页 / ${rawFiles.length} 个文件`,
    )
    // 护栏触发可见化（族B 收口，同 #34 口径）：末页仍满页 = 可能截断，此时上方
    // 「与 changed_files 不一致」的 warn 虽也会触发，但只报条数差、不点明截断原因，
    // 诊断信息弱；显式告警让「评审漏了文件」可直接归因到护栏
    if (rawFiles.length >= 100 * MAX_FILE_PAGES || (page > MAX_FILE_PAGES)) {
      console.warn(
        `[github] ${repo}#${number} 文件列表翻页达护栏上限 ${MAX_FILE_PAGES} 页（${rawFiles.length} 个），列表可能被截断，评审将漏检超限部分的变更文件`,
      )
    }
    if (rawFiles.length !== p.changed_files) {
      console.warn(
        `[github] ${repo}#${number} 拉取文件数 ${rawFiles.length} 与 changed_files=${p.changed_files} 不一致`,
      )
    }
    return {
      key: `github-${p.base.repo?.full_name ?? repo}#${p.number}`,
      platform: 'github',
      repo: p.base.repo?.full_name ?? repo,
      number: p.number,
      title: p.title,
      author: p.user?.login ?? 'unknown',
      state: p.state,
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      fromFork:
        p.head.repo != null &&
        p.head.repo.full_name !== p.base.repo.full_name,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      url: p.html_url,
      body: p.body ?? '',
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changed_files,
      files: rawFiles.map((f) => ({
        path: f.filename,
        status: mapDiffStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? '',
      })),
    }
  },

  async approvePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void> {
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url: `${base}/repos/${owner}/${name}/pulls/${number}/reviews`,
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: JSON.stringify({ event: 'APPROVE' }),
    })
    assertOk(res.status, res.body, 'GitHub')
  },

  async mergePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url: `${base}/repos/${owner}/${name}/pulls/${number}/merge`,
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: JSON.stringify({ merge_method: method }),
    })
    assertOk(res.status, res.body, 'GitHub')
  },

  async closePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void> {
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url: `${base}/repos/${owner}/${name}/pulls/${number}`,
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: JSON.stringify({ state: 'closed' }),
    })
    assertOk(res.status, res.body, 'GitHub')
  },

  async fetchFileContent(
    account: PlatformAccount,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const encodedPath = encodeURIComponent(path).replace(/%2F/gi, '/')
    const res = await httpRequest({
      url: `${base}/repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
    })
    assertOk(res.status, res.body, 'GitHub')
    const payload = parseJsonSafe<{ content?: string | null; encoding?: string }>(
      res.body,
      'GitHub',
      `contents/${path}`,
    )
    // 仅校验编码类型：空文件的 content 为空串是合法返回，应解码为空文本而非误判「内容不可用」（否则该文件被静默跳过复核）；超大文件 GitHub 返回非 base64 编码仍走抛错
    if (payload.encoding !== 'base64') {
      throw new Error(`GitHub 文件内容不可用：${path}`)
    }
    const content = payload.content ?? ''
    // 解码前拦截超大文件：与本地 read_local_file 的 1MB 上限对齐，避免解码内存开销与超长全文进入复核提示词的 token 开销
    if (content.length > MAX_REMOTE_FILE_BASE64_CHARS) {
      throw new Error(
        `GitHub 文件过大（base64 ${content.length} 字符，上限 ${MAX_REMOTE_FILE_BASE64_CHARS} 字符）：${path}`,
      )
    }
    return decodeBase64Text(content)
  },

  // GitHub 的 PR 评论即 issue comments（PR 是特殊 issue），一个端点覆盖读取/发布/编辑。
  // 翻页拉全量（types.ts 约定「归一为正序全量」；评审 #32：只取首页会让超 100 条评论的 PR
  // 漏检末尾的最新汇总评论，幂等更新退化为重复发布）。per_page=100，条数 <100 即止；
  // 循环骨架/护栏/告警统一走 utils.fetchAllComments（评审 #59）
  async listPullRequestComments(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<{ comments: PullRequestComment[]; truncated: boolean }> {
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const { items, truncated } = await fetchAllComments<{
      id: number
      body: string
      created_at?: string
    }>({
      // 条数驱动：items.length < 100 即末页（done）；满页时平台必可翻下一页（hasNext）
      fetchPage: async (page) => {
        const res = await httpRequest({
          // sort/direction 显式固定 created 升序（评审 #47）：truncated「截掉的是最新区间」
          // 的语义不能赌平台默认排序（默认值变更即失真），与 GitLab sort=asc&order_by=created_at
          // 口径对齐；本地排序兜底仍保留（双保险，见列表拉取后）
          url: `${base}/repos/${owner}/${name}/issues/${number}/comments?per_page=100&sort=created&direction=asc&page=${page}`,
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
          },
        })
        assertOk(res.status, res.body, 'GitHub')
        const listUrl = `${base}/repos/${owner}/${name}/issues/${number}/comments`
        const pageItems = parseJsonSafe<
          {
            id: number
            body: string
            created_at?: string
          }[]
        >(res.body, 'GitHub', listUrl)
        return { items: pageItems, done: pageItems.length < 100, hasNext: pageItems.length >= 100 }
      },
      onTruncated: (fetchedCount) => warnCommentTruncation('github', repo, number, fetchedCount),
    })
    const comments = items.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: parseCreatedAt(c.created_at),
    }))
    // created_at 升序排序兜底（评审 #41）：服务端排序参数之上再按时间戳本地归一（双保险）；
    // 缺失/非法时间戳视作最旧排最前（评审 #48，比较器单源见 utils.compareByCreatedAt）
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
    const [owner, name] = splitRepo(repo)
    const base = (account.baseUrl || GITHUB_API).replace(/\/+$/, '')
    const res = await httpRequest({
      url:
        commentId === null
          ? `${base}/repos/${owner}/${name}/issues/${number}/comments`
          : `${base}/repos/${owner}/${name}/issues/comments/${commentId}`,
      method: commentId === null ? 'POST' : 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: JSON.stringify({ body }),
    })
    assertOk(res.status, res.body, 'GitHub')
    return parseJsonSafe<{ id: number }>(
      res.body,
      'GitHub',
      commentId === null ? 'issues comments 发布' : `issues comments/${commentId} 更新`,
    ).id
  },
}
