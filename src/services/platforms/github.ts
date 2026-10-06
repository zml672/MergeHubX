import type {
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
  decodeBase64Text,
  mapDiffStatus,
  MAX_REMOTE_FILE_BASE64_CHARS,
  splitRepo,
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
    const user = JSON.parse(res.body) as { login?: string }
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
    const pulls = JSON.parse(res.body) as GithubPull[]
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
    const p = JSON.parse(pullRes.body) as GithubPullDetail
    const rawFiles: GithubFile[] = []
    let page = 1
    while (page <= MAX_FILE_PAGES) {
      const filesRes = await httpRequest({
        url: `${base}/repos/${owner}/${name}/pulls/${number}/files?per_page=100&page=${page}`,
        headers,
      })
      assertOk(filesRes.status, filesRes.body, 'GitHub')
      const chunk = JSON.parse(filesRes.body) as GithubFile[]
      rawFiles.push(...chunk)
      if (chunk.length < 100) break
      page += 1
    }
    console.debug(
      `[github] ${repo}#${number} 文件列表拉取 ${Math.min(page, MAX_FILE_PAGES)} 页 / ${rawFiles.length} 个文件`,
    )
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
    const payload = JSON.parse(res.body) as {
      content?: string | null
      encoding?: string
    }
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
}
