import type {
  MergeMethod,
  Platform,
  PlatformAccount,
  PullRequestDetail,
  PullRequestQuery,
  PullRequestSummary,
} from '../../types/platform'

export interface PlatformProvider {
  platform: Platform
  defaultBaseUrl: string
  /** 验证令牌：返回当前账号的用户名，令牌无效/权限不足时抛错 */
  fetchAccountUser(account: PlatformAccount): Promise<string>
  listPullRequests(
    account: PlatformAccount,
    query: PullRequestQuery,
  ): Promise<PullRequestSummary[]>
  getPullRequestDetail(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<PullRequestDetail>
  approvePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void>
  mergePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void>
  closePullRequest(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<void>
  /** 读取指定引用下某文件的全文（base64 已解码为 UTF-8 文本），用于第二遍对抗式复核；文件不存在/超限/取文失败时抛错，由调用方跳过复核 */
  fetchFileContent(
    account: PlatformAccount,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string>
}
