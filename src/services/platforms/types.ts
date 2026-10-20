import type {
  MergeMethod,
  Platform,
  PlatformAccount,
  PullRequestComment,
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
  /** 读取 PR/MR 的全部评论（倒序/分页由实现归一为正序全量），供回写前检索既有 MergeHub 汇总评论（R2 幂等更新不追加）。
   *  truncated=true 表示评论量超翻页护栏（MAX_COMMENT_PAGES）被截断，且正序下截掉的是最新区间——
   *  此时「未检索到既有汇总评论」不可信，调用方必须中止发布以免重复（评审 #42） */
  listPullRequestComments(
    account: PlatformAccount,
    repo: string,
    number: number,
  ): Promise<{ comments: PullRequestComment[]; truncated: boolean }>
  /**
   * 发布或更新汇总评论（R2 评审意见回写）：commentId 非空走平台编辑接口原帖更新，
   * 为空发布新评论；返回最终评论 id（供调用方持久化，下次更新复用）。
   * 幂等语义由调用方保证——先 list/findMarker 定位既有评论，本方法只做单一写动作
   */
  upsertPullRequestComment(
    account: PlatformAccount,
    repo: string,
    number: number,
    commentId: number | null,
    body: string,
  ): Promise<number>
}
