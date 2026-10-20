import type { DiffFileStatus } from '../../types/platform'

function extractApiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    return typeof parsed.message === 'string' && parsed.message
      ? parsed.message
      : null
  } catch {
    return null
  }
}

export function assertOk(status: number, body: string, platform: string): void {
  if (status >= 400) {
    const detail = extractApiMessage(body) ?? body.slice(0, 300)
    throw new Error(`${platform} API ${status}: ${detail}`)
  }
}

export function splitRepo(repo: string): [string, string] {
  const parts = repo.split('/').filter(Boolean)
  if (parts.length !== 2) {
    throw new Error('仓库格式应为 owner/repo，例如 vuejs/core')
  }
  return [parts[0], parts[1]]
}

export function mapDiffStatus(status: string): DiffFileStatus {
  if (status === 'added') return 'added'
  if (status === 'removed') return 'removed'
  if (status === 'renamed') return 'renamed'
  return 'modified'
}

export function countDiffLines(patch: string): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@')
    ) {
      continue
    }
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/** 远端文件 base64 内容长度上限：与本地 read_local_file 的 1MB 上限对齐（1MB 原文 base64 后约 139.8 万字符，GitHub/Gitee 返回的 content 还含换行符、约 142 万字符，故取 150 万容差避免误拒恰好 1MB 的文件）；解码前拦截，避免超大内容的解码内存与后续复核 token 开销 */
export const MAX_REMOTE_FILE_BASE64_CHARS = 1_500_000

/** 将平台 contents 接口返回的 base64 内容解码为 UTF-8 文本（兼容平台在内容中插入的换行符） */
export function decodeBase64Text(content: string): string {
  const bin = atob(content.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/** 平台时间串（ISO 8601）→ 毫秒时间戳；缺失/解析失败（Date.parse 返回 NaN）一律归一为
 *  undefined（评审 #48：NaN 直接进比较器会让排序结果依赖引擎实现，威胁「最新评论在末页」
 *  的锚点定位前提）。三平台评论列表排序兜底共用 */
export function parseCreatedAt(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const ts = Date.parse(iso)
  return Number.isFinite(ts) ? ts : undefined
}

/** 评论按创建时间升序比较器（评审 #41 排序兜底共用）：「正序下最新评论在末页」是
 *  findReviewComment「最后命中胜出」的前提。缺时间戳（undefined）视作最旧、整体排最前
 *  （评审 #48 修正注释与语义一致：?? 0 是排最前而非「保持原位」）；两者都缺时间戳时
 *  比较器返回 0，Array.sort 为稳定排序，保持原位序 */
export function compareByCreatedAt(a: { createdAt?: number }, b: { createdAt?: number }): number {
  return (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

/** 2xx 响应体的安全 JSON 解析（评审 #50）：assertOk 只校验状态码，account.baseUrl 配置
 *  异常或中间代理返回 200+HTML 时，裸 JSON.parse 会抛出无平台上下文的 SyntaxError，
 *  用户难以定位出错环节。解析失败抛出携带平台、端点与响应片段的业务错误，替代三平台
 *  list/upsert 共 6 处裸解析 */
export function parseJsonSafe<T>(body: string, platform: string, endpoint: string): T {
  try {
    return JSON.parse(body) as T
  } catch {
    const fragment = body.trim().slice(0, 120)
    throw new Error(
      `${platform} API 返回了非 JSON 响应（${endpoint}）：${fragment || '(空响应体)'}`,
    )
  }
}

/** 评论检索翻页上限：100 条/页 × 20 页 = 2000 条护栏，防异常平台无限翻；正常 PR 远达不到。
 *  评审 #52 单源化：三平台同口径，调整页数只改这里。
 *  翻页循环本身不抽象（驱动机制本质不同：github/gitee 条数驱动 page=N，gitlab 头驱动
 *  x-next-page；truncated 判定随之不同——同测试文件 #37 拒绝工厂化的理由），仅单源化
 *  护栏常量与告警文案这两处真正会同步变更的痛点 */
export const MAX_COMMENT_PAGES = 20

/** 护栏触发告警（评审 #52 单源化）：末页仍满页（条数驱动）/耗尽页数仍有下一页头（头驱动）
 *  时调用，三平台文案统一，仅平台标签与仓库/PR 号注入差异 */
export function warnCommentTruncation(
  platform: string,
  repo: string,
  number: number,
  count: number,
): void {
  console.warn(
    `[${platform}] ${repo}#${number} 评论翻页达护栏上限 ${MAX_COMMENT_PAGES} 页（${count} 条），列表可能被截断，汇总评论锚点可能漏检`,
  )
}

/** 三平台评论列表统一分页骨架（评审 #59，二轮评审坚持后采纳）：
 *  上轮已把护栏常量/告警/解析单源化，残余重复只剩循环控制——本函数收编最后一层。
 *  驱动机制差异由 fetchPage 返回值表达（循环本身与机制无关）：
 *  - 条数驱动（github/gitee）：fetchPage 内部拼 page=N 请求，items.length < PAGE_SIZE 时
 *    返回 done:true（不满页即末页）；护栏触发判定 = 满页 items.length >= PAGE_SIZE
 *  - 头驱动（gitlab）：fetchPage 读取 x-next-page 头，缺失返回 done:true；护栏触发判定 =
 *    末次响应仍有下一页头（hasNext 语义与 done 互补）
 *  终止条件：fetchPage 报告 done、或报告 hasNext 且已达 MAX_COMMENT_PAGES 页（护栏）。
 *  返回 truncated=true 时调用方必须按 #42/#56 契约中止回写（正序下截掉的是最新区间）。
 *  onTruncated 收到触发时刻的已拉条数（此时骨架尚未返回，调用方闭包里的结果变量
 *  还未初始化——TDZ，条数必须由骨架回传而非闭包自取） */
export async function fetchAllComments<T>(options: {
  fetchPage: (page: number) => Promise<{ items: T[]; done: boolean; hasNext: boolean }>
  onTruncated: (fetchedCount: number) => void
}): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const { items: pageItems, done, hasNext } = await options.fetchPage(page)
    items.push(...pageItems)
    if (done) return { items, truncated: false }
    if (hasNext && page === MAX_COMMENT_PAGES) {
      options.onTruncated(items.length)
      return { items, truncated: true }
    }
  }
  // 不可达（循环内每条路径都 return），TypeScript 收窄要求兜底
  return { items, truncated: false }
}

/** Markdown 有序列表嵌套行缩进（评审 #49 语义，族 C 收口单源化）：
 *  `10.` 起两位序号下，固定 3 空格的「- 子行」会脱离父项被 CommonMark 解析为
 *  顶层列表或懒延续行，嵌套渲染失效；`String(index+1).length + 2` 使任意序号宽度下
 *  子行标记列都与父项内容列对齐。评论侧（reviewComment.issueLines）与导出侧
 *  （useReviewExport）共用——这正是族 C「平行实现各自维护格式公式必漂移」的教训，
 *  #49 只改了评论侧、导出侧漏改的根因即缺乏单源 */
export function mdNestedIndent(ordinal: number): string {
  return ' '.repeat(String(ordinal).length + 2)
}
