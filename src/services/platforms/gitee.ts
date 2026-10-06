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

const GITEE_API = 'https://gitee.com'

interface GiteePull {
  number: number
  title: string
  state: string
  html_url: string
  user: { login: string } | null
  created_at: string
  updated_at: string
  head: { ref: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string } | null }
}

interface GiteePullDetail extends GiteePull {
  body: string | null
  additions: number
  deletions: number
}

/** Gitee files 接口的 patch 字段实为对象，diff 正文存放在 diff 键中 */
interface GiteePatchInfo {
  diff?: string
}

interface GiteeFile {
  filename: string
  status: string
  additions: number | string
  deletions: number | string
  patch?: string | GiteePatchInfo | null
}

/** 将 Gitee 的 patch 字段归一化为纯文本 diff，兼容对象/字符串/缺失三种形态 */
function normalizePatch(patch: GiteeFile['patch']): string {
  if (typeof patch === 'string') return patch
  if (patch && typeof patch === 'object' && typeof patch.diff === 'string') {
    return patch.diff
  }
  return ''
}

export const giteeProvider: PlatformProvider = {
  platform: 'gitee',
  defaultBaseUrl: GITEE_API,

  async fetchAccountUser(account: PlatformAccount): Promise<string> {
    const res = await httpRequest({
      url: `${GITEE_API}/api/v5/user`,
      headers: account.token
        ? { Authorization: `Bearer ${account.token}` }
        : undefined,
    })
    assertOk(res.status, res.body, 'Gitee')
    const user = JSON.parse(res.body) as { login?: string }
    return user.login ?? ''
  },

  async listPullRequests(
    account: PlatformAccount,
    query: PullRequestQuery,
  ): Promise<PullRequestSummary[]> {
    const [owner, repo] = splitRepo(query.repo)
    const res = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${repo}/pulls?state=${query.state}&per_page=50`,
      headers: account.token
        ? { Authorization: `Bearer ${account.token}` }
        : undefined,
    })
    assertOk(res.status, res.body, 'Gitee')
    const pulls = JSON.parse(res.body) as GiteePull[]
    return pulls.map((p) => ({
      key: `gitee-${p.base.repo?.full_name ?? query.repo}#${p.number}`,
      platform: 'gitee',
      repo: p.base.repo?.full_name ?? query.repo,
      number: p.number,
      title: p.title,
      author: p.user?.login ?? 'unknown',
      state: p.state,
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      fromFork:
        p.head.repo != null &&
        p.base.repo != null &&
        p.head.repo.full_name !== p.base.repo.full_name,
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
    const headers = account.token
      ? { Authorization: `Bearer ${account.token}` }
      : undefined
    const pullRes = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${name}/pulls/${number}`,
      headers,
    })
    assertOk(pullRes.status, pullRes.body, 'Gitee')
    const p = JSON.parse(pullRes.body) as GiteePullDetail
    const filesRes = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${name}/pulls/${number}/files`,
      headers,
    })
    assertOk(filesRes.status, filesRes.body, 'Gitee')
    const rawFiles = JSON.parse(filesRes.body) as GiteeFile[]
    return {
      key: `gitee-${p.base.repo?.full_name ?? repo}#${p.number}`,
      platform: 'gitee',
      repo: p.base.repo?.full_name ?? repo,
      number: p.number,
      title: p.title,
      author: p.user?.login ?? 'unknown',
      state: p.state,
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      fromFork:
        p.head.repo != null &&
        p.base.repo != null &&
        p.head.repo.full_name !== p.base.repo.full_name,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      url: p.html_url,
      body: p.body ?? '',
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: rawFiles.length,
      files: rawFiles.map((f) => ({
        path: f.filename,
        status: mapDiffStatus(f.status),
        additions: Number(f.additions) || 0,
        deletions: Number(f.deletions) || 0,
        patch: normalizePatch(f.patch),
      })),
    }
  },

  async approvePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void> {
    const [owner, name] = splitRepo(repo)
    const res = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${name}/pulls/${number}/review`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: new URLSearchParams({ event: 'APPROVE' }).toString(),
    })
    assertOk(res.status, res.body, 'Gitee')
  },

  async mergePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    const [owner, name] = splitRepo(repo)
    const res = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${name}/pulls/${number}/merge`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: new URLSearchParams({ merge_method: method }).toString(),
    })
    assertOk(res.status, res.body, 'Gitee')
  },

  async closePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void> {
    const [owner, name] = splitRepo(repo)
    const res = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${name}/pulls/${number}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(account.token ? { Authorization: `Bearer ${account.token}` } : {}),
      },
      body: new URLSearchParams({ state: 'closed' }).toString(),
    })
    assertOk(res.status, res.body, 'Gitee')
  },

  async fetchFileContent(
    account: PlatformAccount,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const [owner, name] = splitRepo(repo)
    const encodedPath = encodeURIComponent(path).replace(/%2F/gi, '/')
    const res = await httpRequest({
      url: `${GITEE_API}/api/v5/repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      headers: account.token
        ? { Authorization: `Bearer ${account.token}` }
        : undefined,
    })
    assertOk(res.status, res.body, 'Gitee')
    const payload = JSON.parse(res.body) as {
      content?: string | null
      encoding?: string
    }
    // 仅校验编码类型：空文件的 content 为空串是合法返回，应解码为空文本而非误判「内容不可用」（否则该文件被静默跳过复核）
    if (payload.encoding !== 'base64') {
      throw new Error(`Gitee 文件内容不可用：${path}`)
    }
    const content = payload.content ?? ''
    // 解码前拦截超大文件：与本地 read_local_file 的 1MB 上限对齐，避免解码内存开销与超长全文进入复核提示词的 token 开销
    if (content.length > MAX_REMOTE_FILE_BASE64_CHARS) {
      throw new Error(
        `Gitee 文件过大（base64 ${content.length} 字符，上限 ${MAX_REMOTE_FILE_BASE64_CHARS} 字符）：${path}`,
      )
    }
    return decodeBase64Text(content)
  },
}
