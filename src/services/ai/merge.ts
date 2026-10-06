/** 评审结果的归一化与合并：模型输出 JSON 解析容错、跨批去重排序、总评合成、上轮问题清单闭环 */

import { chatCompletionStream, isReviewCancelled } from './client'
import type { ReviewCancelHandle, TokenUsage } from './client'
import { issueFingerprint } from '../../utils/issueFingerprint'
import { logAiError } from '../aiDebugLog'
import type {
  AiIssue,
  AiIssueSeverity,
  AiIssueStatus,
  AiIssueType,
  AiModelConfig,
  AiPreviousCheck,
  AiReviewResult,
  AiRiskLevel,
} from '../../types/ai'
import type { AiReviewListener } from './engine'

const RISK_LEVELS: AiRiskLevel[] = ['low', 'medium', 'high']
const RISK_RANK: Record<AiRiskLevel, number> = { low: 0, medium: 1, high: 2 }
const SEVERITIES: AiIssueSeverity[] = ['low', 'medium', 'high']
const ISSUE_TYPES: AiIssueType[] = [
  'bug',
  'security',
  'performance',
  'style',
  'convention',
]
const PREV_STATUSES: AiIssueStatus[] = ['fixed', 'partial', 'not_fixed']
const PREV_STATUS_RANK: Record<AiIssueStatus, number> = {
  not_fixed: 0,
  partial: 1,
  fixed: 2,
}

interface RawReview {
  summary?: unknown
  riskLevel?: unknown
  issues?: unknown
  previousChecks?: unknown
}

function normalizeReview(
  raw: RawReview,
  model: string,
  ruleCount: number,
  ruleSetName: string,
): AiReviewResult {
  const summary =
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : '（模型未提供总评）'
  const riskLevel = RISK_LEVELS.includes(raw.riskLevel as AiRiskLevel)
    ? (raw.riskLevel as AiRiskLevel)
    : 'medium'
  const issues = Array.isArray(raw.issues)
    ? raw.issues.flatMap((item): AiIssue[] => {
        if (!item || typeof item !== 'object') return []
        const obj = item as Record<string, unknown>
        const comment = typeof obj.comment === 'string' ? obj.comment.trim() : ''
        const file = typeof obj.file === 'string' ? obj.file : ''
        // 缺 file 的问题无法定位、无法进入复核与闭环比对，与下方 previousChecks 分支同口径丢弃
        if (!comment || !file) return []
        const line =
          typeof obj.line === 'number' && Number.isFinite(obj.line)
            ? Math.max(0, Math.round(obj.line))
            : 0
        const severity = SEVERITIES.includes(obj.severity as AiIssueSeverity)
          ? (obj.severity as AiIssueSeverity)
          : 'medium'
        const type = ISSUE_TYPES.includes(obj.type as AiIssueType)
          ? (obj.type as AiIssueType)
          : 'bug'
        const suggestion =
          typeof obj.suggestion === 'string' && obj.suggestion.trim()
            ? obj.suggestion.trim()
            : undefined
        return [{ file, line, severity, type, comment, suggestion }]
      })
    : []
  const previousChecks = Array.isArray(raw.previousChecks)
    ? raw.previousChecks.flatMap((item): AiPreviousCheck[] => {
        if (!item || typeof item !== 'object') return []
        const obj = item as Record<string, unknown>
        const comment = typeof obj.comment === 'string' ? obj.comment.trim() : ''
        const file = typeof obj.file === 'string' ? obj.file : ''
        if (!comment || !file) return []
        const status = PREV_STATUSES.includes(obj.status as AiIssueStatus)
          ? (obj.status as AiIssueStatus)
          : 'not_fixed'
        const line =
          typeof obj.line === 'number' && Number.isFinite(obj.line)
            ? Math.max(0, Math.round(obj.line))
            : 0
        const severity = SEVERITIES.includes(obj.severity as AiIssueSeverity)
          ? (obj.severity as AiIssueSeverity)
          : 'medium'
        const type = ISSUE_TYPES.includes(obj.type as AiIssueType)
          ? (obj.type as AiIssueType)
          : 'bug'
        const note =
          typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : undefined
        return [{ file, line, severity, type, comment, status, note }]
      })
    : []
  return {
    summary,
    riskLevel,
    issues,
    degraded: false,
    reviewedAt: Date.now(),
    model,
    ruleCount,
    ruleSetName,
    ...(previousChecks.length > 0 ? { previousChecks } : {}),
  }
}

function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

/** 从原文提取首个括号平衡的 JSON 对象（字符串字面量内的括号/转义不参与配对）：
 *  extractJsonBlock 的两个软肋——围栏懒匹配被值内 ``` 截断、lastIndexOf('}') 把 JSON 后
 *  附带的说明文字一并切入——都会产出损坏候选导致 JSON.parse 抛错；平衡扫描不依赖围栏
 *  与末尾位置，天然免疫上述两类脏输出 */
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 解析模型输出的评审 JSON 并归一化（纯函数）：围栏候选解析失败时回退平衡扫描候选，
 *  两路均无有效 JSON 才抛错——单批输出脏围栏/尾随文字时不至于整批评审丢失（导出供单元测试） */
export function parseReviewContent(
  content: string,
  model: string,
  ruleCount: number,
  ruleSetName: string,
): AiReviewResult {
  const candidates = [extractJsonBlock(content), extractBalancedJson(content)]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return normalizeReview(JSON.parse(candidate) as RawReview, model, ruleCount, ruleSetName)
    } catch {
      // 当前候选损坏（截断/夹带说明文字），尝试下一候选
    }
  }
  throw new Error('输出中没有 JSON')
}

export interface BatchOutcome {
  result: AiReviewResult
  answerChars: number
  reasoningChars: number
  usage?: TokenUsage
  elapsedMs: number
}

const SEVERITY_RANK: Record<AiIssueSeverity, number> = { high: 0, medium: 1, low: 2 }

function dedupeAndSortIssues(issues: AiIssue[]): AiIssue[] {
  const seen = new Map<string, AiIssue>()
  for (const issue of issues) {
    // 行号 0 是纯文件级结论（无位置锚点），file+type 相同不代表同一问题：
    // 键中并入描述指纹区分不同文件级问题；行号 >0 维持原键（跨批重复上报靠位置身份合并）
    const key =
      issue.line > 0
        ? `${issue.file}\u0000${issue.line}\u0000${issue.type}`
        : `${issue.file}\u0000${issue.line}\u0000${issue.type}\u0000${issueFingerprint(issue)}`
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, issue)
      continue
    }
    const merged: AiIssue = {
      ...existing,
      // 跨批/同批重复上报时评级可能不一致，取更严重者（rank 更小），避免风险被低估影响排序
      severity:
        SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existing.severity]
          ? issue.severity
          : existing.severity,
      comment:
        issue.comment.length > existing.comment.length ? issue.comment : existing.comment,
      suggestion: issue.suggestion ?? existing.suggestion,
    }
    seen.set(key, merged)
  }
  return [...seen.values()].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    const byFile = a.file.localeCompare(b.file)
    if (byFile !== 0) return byFile
    return a.line - b.line
  })
}

function sortPreviousChecks(checks: AiPreviousCheck[]): AiPreviousCheck[] {
  return [...checks].sort((a, b) => {
    const byStatus = PREV_STATUS_RANK[a.status] - PREV_STATUS_RANK[b.status]
    if (byStatus !== 0) return byStatus
    const byFile = a.file.localeCompare(b.file)
    if (byFile !== 0) return byFile
    return a.line - b.line
  })
}

/** 跨批核对结论去重 + 排序：大文件跨批时同一文件的上轮清单会随批次重复下发/返回，
 *  不去重则报告对比清单出现成倍重复条目。身份键与闭环/角标同口径（issueFingerprint，
 *  行号不参与）。冲突时保留更悲观的结论（not_fixed > partial > fixed）：仅覆盖该问题
 *  所在范围的批次有真实依据，靠前批次的乐观 fixed 会掩盖实际未修复，绕过闭环补入；
 *  保守结论的代价只是对比清单显示偏悲观，漏报的代价是真实问题缺席 */
function compactPreviousChecks(checks: AiPreviousCheck[]): AiPreviousCheck[] | undefined {
  if (checks.length === 0) return undefined
  const seen = new Map<string, AiPreviousCheck>()
  for (const check of checks) {
    const key = issueFingerprint(check)
    const existing = seen.get(key)
    if (!existing || PREV_STATUS_RANK[check.status] < PREV_STATUS_RANK[existing.status]) {
      seen.set(key, check)
    }
  }
  return sortPreviousChecks([...seen.values()])
}

/** riskLevel 下限校准：closeIssueLoop 可能补入高严重度问题而模型总评为 low，按最终清单的
 *  最高严重度抬高整体风险等级——只升不降，模型给出的等级仍可作为不低于清单的上限保留 */
function calibratedRiskLevel(riskLevel: AiRiskLevel, issues: AiIssue[]): AiRiskLevel {
  const maxSeverity = issues.reduce<AiIssueSeverity>(
    (max, i) => (SEVERITY_RANK[i.severity] < SEVERITY_RANK[max] ? i.severity : max),
    'low',
  )
  return RISK_RANK[riskLevel] >= RISK_RANK[maxSeverity] ? riskLevel : maxSeverity
}

/** 从未闭环核对结论构造派生问题：沿用核对结论自身字段，上轮复核备注转为修复建议保留信息 */
function deriveIssueFromCheck(check: AiPreviousCheck): AiIssue {
  return {
    file: check.file,
    line: check.line,
    severity: check.severity,
    type: check.type,
    comment: check.comment,
    suggestion: check.note ? `上轮复核备注：${check.note}` : undefined,
  }
}

/** 行号漂移容差：同一问题两次分析间因代码增删产生的小幅位移 */
const NEAR_LINE_TOLERANCE = 5
/** 描述相似度阈值（字符 bigram Dice 系数）：达到即视为同一问题的改写复述 */
const COMMENT_SIMILARITY_THRESHOLD = 0.4
/** 子串包含快速通道的最小长度门槛：被包含串短于该值时不走快速通道，落入 bigram 计算
 *  （自然低分）——过短子串被任意长描述包含即判相似会误吞真实未修复问题的派生 */
const CONTAINMENT_MIN_CHARS = 8

function similarityOf(a: string, b: string): number {
  const na = a.replace(/\s+/g, '').toLowerCase()
  const nb = b.replace(/\s+/g, '').toLowerCase()
  // 长度门槛必须先于包含判断：任一侧归一化后不足 2 字符（如单字泛称「错」）没有可比性，
  // 否则会被任意长描述的包含关系判为完全相似，闭环保障被绕过
  if (!na || !nb || na.length < 2 || nb.length < 2) return 0
  if (na === nb) return 1
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length <= nb.length ? nb : na
  // 子串包含快速通道：被包含串达最小长度门槛才可信；过短时落入 bigram 计算（自然低分）
  if (longer.includes(shorter) && shorter.length >= CONTAINMENT_MIN_CHARS) return 1
  const bigramsOf = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ba = bigramsOf(na)
  const bb = bigramsOf(nb)
  let inter = 0
  for (const g of ba) if (bb.has(g)) inter += 1
  return (2 * inter) / (ba.size + bb.size)
}

/** 宽松命中：模型复述未修复问题时措辞会改写、行号有噪声，指纹严格相等会漏判，
 *  同一问题将同时保留模型上报版本与派生版本，造成清单重复条目。
 *  判定（同文件为前提，满足其一即视为模型已上报）：
 *  ① 同类型且行号相邻（±NEAR_LINE_TOLERANCE 行）——模型行号存在噪声，同文件同类型近距离几乎必为同一问题；
 *    行号为 0 表示纯文件级结论（无具体位置），不参与行号邻近判定，否则 0-0=0 恒命中，
 *    模型随手报的另一条文件级问题会抑制真实未修复问题的闭环补入；
 *  ② 描述相似度达标（不要求行号与类型）——容忍代码位移导致的行号大幅漂移与归类偏差 */
function looselyReported(issues: AiIssue[], check: AiPreviousCheck): boolean {
  return issues.some((issue) => {
    if (issue.file !== check.file) return false
    if (
      issue.type === check.type &&
      issue.line > 0 &&
      check.line > 0 &&
      Math.abs(issue.line - check.line) <= NEAR_LINE_TOLERANCE
    ) {
      return true
    }
    return similarityOf(issue.comment, check.comment) >= COMMENT_SIMILARITY_THRESHOLD
  })
}

/** 清单闭环：提示词要求模型把未修复/部分修复的问题照常列入 issues 属软约束（实测出现过漏列），此处对未匹配任何问题的核对结论由代码确定性补入，构造性保证「对比结论必在问题清单」（导出供单元测试） */
export function closeIssueLoop(issues: AiIssue[], checks: AiPreviousCheck[]): AiIssue[] {
  const reported = new Set(issues.map((issue) => issueFingerprint(issue)))
  const missing = checks
    .filter(
      (c) =>
        (c.status === 'partial' || c.status === 'not_fixed') &&
        !reported.has(issueFingerprint(c)) &&
        !looselyReported(issues, c),
    )
    .map(deriveIssueFromCheck)
  return missing.length > 0 ? dedupeAndSortIssues([...issues, ...missing]) : issues
}

async function mergeResults(
  config: AiModelConfig,
  results: AiReviewResult[],
  previous: AiReviewResult | undefined,
  onEvent: AiReviewListener | undefined,
  cancel?: ReviewCancelHandle,
  logDir?: string,
): Promise<BatchOutcome> {
  if (results.length === 1) {
    const issues = closeIssueLoop(
      dedupeAndSortIssues(results[0].issues),
      results[0].previousChecks ?? [],
    )
    return {
      result: {
        ...results[0],
        issues,
        riskLevel: calibratedRiskLevel(results[0].riskLevel, issues),
        previousChecks: compactPreviousChecks(results[0].previousChecks ?? []),
        comparedWith: results[0].previousChecks?.length ? previous?.reviewedAt : undefined,
      },
      answerChars: 0,
      reasoningChars: 0,
      usage: undefined,
      elapsedMs: 0,
    }
  }
  const issues = dedupeAndSortIssues(results.flatMap((r) => r.issues))
  const degraded = results.some((r) => r.degraded)
  const riskLevel = results.reduce<AiRiskLevel>(
    (max, r) => (RISK_RANK[r.riskLevel] > RISK_RANK[max] ? r.riskLevel : max),
    'low',
  )
  const startedAt = Date.now()
  let summary = ''
  let answerChars = 0
  let reasoningChars = 0
  let usage: TokenUsage | undefined
  /** 总评合成失败降级为分批拼接的标记：随 degraded 透出，下游可感知总评并非模型连贯合成 */
  let synthesisFailed = false
  try {
    onEvent?.({ type: 'merging' })
    const merged = await chatCompletionStream(config, [
      {
        role: 'system',
        content:
          '你是代码评审助手。把同一合并请求多个批次的分项总评合成为一段连贯的中文核心总评（不超过 3 句），指出整体变更性质与最需要关注的风险方向。不要罗列文件数量、各等级问题数等统计信息（系统会精确统计），不要逐条复述问题。直接输出总评文本，不要 JSON，不要列表，不要任何解释性文字。',
      },
      {
        role: 'user',
        content: results.map((r, i) => `【第 ${i + 1} 批】${r.summary}`).join('\n'),
      },
    ], undefined, cancel)
    summary = merged.content
    answerChars = merged.answerChars
    reasoningChars = merged.reasoningChars
    usage = merged.usage
  } catch (err) {
    // 用户主动取消不落盘错误日志、不做拼接降级：取消必须中断评审（与批次评审/治理提炼的取消处理一致）
    if (isReviewCancelled(err)) throw err
    if (logDir) logAiError(logDir, 'AI 评审总评合成（已降级为分批拼接）', err, config.model)
    synthesisFailed = true
    summary = results.map((r, i) => `【批次${i + 1}】${r.summary}`).join('\n')
  }
  const previousChecks = compactPreviousChecks(results.flatMap((r) => r.previousChecks ?? []))
  const finalIssues = closeIssueLoop(issues, previousChecks ?? [])
  return {
    result: {
      summary: summary.trim() || '（模型未提供总评）',
      riskLevel: calibratedRiskLevel(riskLevel, finalIssues),
      issues: finalIssues,
      degraded: degraded || synthesisFailed,
      reviewedAt: Date.now(),
      model: config.model,
      ruleCount: results[0]?.ruleCount ?? 0,
      ruleSetName: results[0]?.ruleSetName,
      previousChecks,
      // 与单批分支同口径：compactPreviousChecks 空输入返回 undefined，此处 truthiness 判断
      // 现状等价于 length > 0，显式写 length 防止将来返回值语义变化时误标 comparedWith
      comparedWith: previousChecks && previousChecks.length > 0 ? previous?.reviewedAt : undefined,
    },
    answerChars,
    reasoningChars,
    usage,
    elapsedMs: Date.now() - startedAt,
  }
}

export { mergeResults, dedupeAndSortIssues, extractJsonBlock }
