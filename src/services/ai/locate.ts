/** 意见行号重定位：用文件全文对模型报的行号做程序化校验与修正（借鉴 ocr 意见重定位）。纯确定性、零模型调用 */

import { ReviewCancelledError } from './client'
import type { ReviewCancelHandle } from './client'
import { VERIFY_FILE_SIZE_LIMIT } from './verify'
import type { FileContentFetcher } from './verify'
import type { AiIssue, AiIssueLocationStatus } from '../../types/ai'

/** 取文并发数：取文本地读取为主、偶发远端，小并发即可摊平多文件往返，无需像模型调用那样保守限流 */
const LOCATE_FETCH_CONCURRENCY = 6

/** 共享缓存的条目上限：超出按插入序淘汰最旧条目（Map 迭代序即插入序），被淘汰文件由 verify 阶段
 *  自行取文兜底（语义等同缓存未命中）。数百文件的超大变更若不设限，全文常驻内存直至评审结束 */
const CONTENT_CACHE_MAX_ENTRIES = 64

/** 重定位结果统计：三态计数，供 UI 摘要与事件上报 */
export interface RelocateStat {
  /** 行号经文件全文校验在 [1, 总行数] 范围内，坐标可信 */
  confirmed: number
  /** 原行号越界（模型引用旧版本行数、diff 上下文算错等），已修正到文件末行并记 originalLine */
  relocated: number
  /** 无法取证（文件不在变更白名单/取文失败/超限/行号无效），行号不可信，UI 降级展示 */
  unlocatable: number
  /** 取文失败的文件数（>0 说明部分文件未能校验，便于区分「模型全报了有效坐标」与「取证通道挂了」） */
  failedFiles?: number
}

/**
 * 重定位三态的展示元数据（唯一口径）：徽标文案/颜色/tooltip 全部由此导出，
 * UI（AiReportPanel 等）只取值渲染。tooltip 与本文件的修正策略同处一处——
 * 策略调整（如 relocated 改为就近修正、unlocatable 细分原因）时只改这里，
 * 展示自动跟随实现，杜绝文案与行为脱节。tooltip 以意见为参数：relocated
 * 需读 originalLine 展示漂移轨迹
 */
export interface LocationStatusMeta {
  /** 徽标文案 */
  label: string
  /** 徽标颜色（ant-design tag color 语义值） */
  color: string
  /** 是否显示徽标：confirmed 为常态多数派不展示（避免满屏绿标噪音），异常态才提示 */
  badge: boolean
  /** tooltip：参数为意见本身（旧数据可能无 locationStatus 相关字段，自行兜底） */
  tooltip: (issue: AiIssue) => string
}

export const LOCATION_STATUS_META: Record<AiIssueLocationStatus, LocationStatusMeta> = {
  confirmed: {
    label: '行号可信',
    color: 'success',
    badge: false,
    tooltip: () => '行号经文件全文校验在 [1, 总行数] 范围内，坐标可信',
  },
  relocated: {
    label: '行号已修正',
    color: 'warning',
    badge: true,
    tooltip: (issue) =>
      issue.originalLine != null
        ? `模型原报行号 ${issue.originalLine} 已越界，程序修正为文件末行`
        : '行号越界，程序已修正',
  },
  unlocatable: {
    label: '位置存疑',
    color: 'default',
    badge: true,
    tooltip: () => '该意见的行号无法取证（文件不在本次变更或取证失败），位置仅供参考',
  },
}

/**
 * 对单条意见执行行号校验与修正（导出供单元测试）：三态定位。
 * - confirmed：line ∈ [1, 总行数]，坐标可信
 * - relocated：line 越界但可修正，clamp 到文件末行并记录 originalLine
 * - unlocatable：不可取证，不删除不修改行号（ocr 偏置：保留错误坐标只浪费几秒阅读，
 *   误删正确意见永远无人知晓——宁可漏判不误杀）
 */
export function relocateIssueAgainstContent(
  issue: AiIssue,
  content: string,
): { status: AiIssueLocationStatus; line: number } {
  // 末尾换行不产生空尾行：'a\nb\n' 是 2 行而非 3 行——否则指向真实末行+1 的意见会被误判 confirmed 并定位到空行
  const totalLines = content.replace(/\n$/, '').split('\n').length
  const line = issue.line
  // 行号无效：契约是 1-based 正整数（提示词约定），0/负数/NaN/小数说明模型瞎编，坐标不可信
  if (!Number.isFinite(line) || !Number.isInteger(line) || line <= 0) {
    issue.locationStatus = 'unlocatable'
    return { status: 'unlocatable', line }
  }
  if (line <= totalLines) {
    issue.locationStatus = 'confirmed'
    return { status: 'confirmed', line }
  }
  // 越界（line > totalLines）：坐标已漂移，clamp 到文件末行保留可读性，记 originalLine 供展示漂移轨迹
  issue.originalLine = line
  issue.locationStatus = 'relocated'
  issue.line = totalLines
  return { status: 'relocated', line: totalLines }
}

/** 重定位与复核共享的文件内容缓存：调用方持有，relocate 回填成功取证的内容，verify 取文前先查，避免同批文件重复拉取 */
export type ContentCache = Map<string, string>

/**
 * 重定位与复核共享的「已知超限文件」哨兵：调用方持有，relocate 取文发现超限时记入路径，
 * verify 命中哨兵直接跳过取文——否则超限文件在定位阶段已完整传输一次、复核阶段再完整
 * 传输一次后丢弃，大文件被双倍传输。与 ContentCache 同为 engine 持有的共享上下文
 */
export type OversizedFileSet = Set<string>

/**
 * 意见行号重定位入口：对每条意见按文件全文校验行号范围，程序保证坐标可信。
 * 纯确定性、零模型调用——任何环节失败（无取证通道、文件超限/取文失败）都把该条意见
 * 标记为 unlocatable 降级展示，绝不删除（ocr 偏置），也绝不抛错阻断评审主流程；
 * 唯一例外是用户取消：抛 ReviewCancelledError 由上游统一处理（红线，禁止静默返回）。
 *
 * changedFiles 为本次变更文件路径白名单（与复核取文同语义）：issue.file 源自第一遍模型输出
 * （受不可信 diff 操纵），虚构/穿越路径或未纳入评审的敏感文件不发起取文，直接 unlocatable
 *
 * contentCache 传入时，取文成功且未超限的文件内容会回填缓存，供后续复核阶段复用（免二次拉取）；
 * oversizedFiles 传入时，取文发现超限的文件路径记入哨兵，供复核阶段免拉取直接跳过（免大文件二次传输）
 */
export async function relocateIssues(
  issues: AiIssue[],
  fetchFileContent: FileContentFetcher,
  changedFiles: Set<string>,
  cancel?: ReviewCancelHandle,
  contentCache?: ContentCache,
  oversizedFiles?: OversizedFileSet,
): Promise<RelocateStat> {
  const stat: RelocateStat = { confirmed: 0, relocated: 0, unlocatable: 0 }
  // 按文件分组：同一文件的全文只取一次，多条意见共享一次取证
  const issuesByFile = new Map<string, AiIssue[]>()
  for (const issue of issues) {
    if (!changedFiles.has(issue.file)) {
      issue.locationStatus = 'unlocatable'
      stat.unlocatable += 1
      continue
    }
    // 已知超限文件（本阶段此前取文已确认超限）：不重复取文，直接降级
    if (oversizedFiles?.has(issue.file)) {
      issue.locationStatus = 'unlocatable'
      stat.unlocatable += 1
      continue
    }
    const list = issuesByFile.get(issue.file)
    if (list) list.push(issue)
    else issuesByFile.set(issue.file, [issue])
  }
  /** 取文失败的文件数 */
  let failedFiles = 0
  /** 缓存回填（带条目上限）：超限时按插入序淘汰最旧条目（Map 迭代序即插入序）；
   *  被淘汰的文件由 verify 阶段自行取文兜底，语义等同缓存未命中，正确性不受影响 */
  const cachePut = (path: string, content: string): void => {
    if (!contentCache) return
    while (contentCache.size >= CONTENT_CACHE_MAX_ENTRIES) {
      const oldest = contentCache.keys().next().value
      if (oldest === undefined) break
      contentCache.delete(oldest)
    }
    contentCache.set(path, content)
  }
  /** 单文件校验：先查共享缓存 → 未命中取文 → 超限降级或逐条三态判定。供并发 worker 调用 */
  const processFile = async (path: string, fileIssues: AiIssue[]): Promise<void> => {
    try {
      let content = contentCache?.get(path)
      if (content === undefined) {
        content = await fetchFileContent(path)
        // 只有可用的内容才回填缓存：超限/空内容不回填，复核阶段仍会自行取文兜底
        if (content && content.length <= VERIFY_FILE_SIZE_LIMIT) cachePut(path, content)
      }
      if (!content || content.length > VERIFY_FILE_SIZE_LIMIT) {
        // 超限/空内容：无法可靠取证，该文件全部意见降级，行号保持原值不动；
        // 记入超限哨兵，复核阶段免拉取直接跳过（否则大文件会被二次完整传输后丢弃）
        oversizedFiles?.add(path)
        for (const issue of fileIssues) {
          issue.locationStatus = 'unlocatable'
          stat.unlocatable += 1
        }
        return
      }
      for (const issue of fileIssues) {
        const r = relocateIssueAgainstContent(issue, content)
        if (r.status === 'confirmed') stat.confirmed += 1
        else if (r.status === 'relocated') stat.relocated += 1
        else stat.unlocatable += 1
      }
    } catch (err) {
      if (err instanceof ReviewCancelledError) throw err
      // 取文失败（fork 仓库 404、二进制、权限不足等）：该文件全部意见降级，行号保持原值
      failedFiles += 1
      for (const issue of fileIssues) {
        issue.locationStatus = 'unlocatable'
        stat.unlocatable += 1
      }
    }
  }
  // 有界并发取文：意见分散多文件时网络往返不再串行放大；worker 模式与 verify 一致
  const entries = [...issuesByFile.entries()]
  let nextIndex = 0
  const workers: Promise<void>[] = []
  for (let worker = 0; worker < Math.min(LOCATE_FETCH_CONCURRENCY, entries.length); worker += 1) {
    workers.push(
      (async () => {
        for (;;) {
          if (cancel?.cancelled) throw new ReviewCancelledError()
          const index = nextIndex
          if (index >= entries.length) return
          nextIndex += 1
          const [path, fileIssues] = entries[index]
          await processFile(path, fileIssues)
        }
      })(),
    )
  }
  await Promise.all(workers)
  if (failedFiles > 0) stat.failedFiles = failedFiles
  return stat
}
