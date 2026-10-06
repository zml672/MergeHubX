/** 评审引擎编排：批次并发调度、重试与降级、断点续跑指纹、事件流，串联分批→复核→合并全流程 */

import { chatCompletionStream, effectiveConcurrency, mergeUsage, ReviewCancelledError, isReviewCancelled } from './client'
import type { AiReviewMode, BatchPlan } from './batching'
import { buildBatchPlan, buildBatchPrompt, buildManifest } from './batching'
import { buildSystemPrompt } from './prompts'
import { mergeResults, parseReviewContent } from './merge'
import type { BatchOutcome } from './merge'
import { verifyIssues } from './verify'
import type { FileContentFetcher } from './verify'
import { localLogDir, remoteLogDir, logAiRequest, logAiAnswer, logAiError, shortHash } from '../aiDebugLog'
import type { AiModelConfig, AiReviewResult, GovernanceRecord, ReviewRule } from '../../types/ai'
import type { PullRequestDetail } from '../../types/platform'
import type { ChatMessage, ReviewCancelHandle, TokenUsage } from './client'

export type AiReviewEvent =
  | {
      type: 'plan'
      mode: AiReviewMode
      totalFiles: number
      analyzedFiles: number
      excludedFiles: number
      batches: number
    }
  | { type: 'batchStart'; batch: number; totalBatches: number; sentChars: number }
  | {
      type: 'batchStream'
      batch: number
      thinking: boolean
      answerChars: number
      reasoningChars: number
    }
  | {
      type: 'batchRetry'
      batch: number
      /** format：输出格式异常重试（批次内部）；network：限流/网络波动退避重试 */
      reason?: 'format' | 'network'
      waitMs?: number
    }
  | {
      type: 'batchDone'
      batch: number
      elapsedMs: number
      answerChars: number
      reasoningChars: number
      usage?: TokenUsage
      /** 批次评审结果：随事件带回供调用方逐批持久化断点；续跑跳过的批次不触发本事件 */
      result?: AiReviewResult
    }
  | { type: 'verifyStart'; files: number; issues: number }
  | {
      type: 'verifyDone'
      confirmed: number
      filtered: number
      /** 未获显式结论或未下发的条目数（取证失败/输出异常/模型未表态/截断剔除） */
      unverified: number
      /** 复核调用失败的文件数（鉴权失效/模型配置错误等系统性原因整批失败时等于 totalFiles） */
      failedFiles?: number
      /** 纳入复核的文件总数：与 failedFiles 配合计算失败占比 */
      totalFiles?: number
    }
  /** 复核未运行时的可观测性事件：reason 说明跳过原因（无取证通道/无可复核内容/取证全部失败） */
  | { type: 'verifySkip'; reason: string }
  | { type: 'merging' }
  | {
      type: 'done'
      elapsedMs: number
      sentChars: number
      answerChars: number
      reasoningChars: number
      usage: TokenUsage
    }

export type AiReviewListener = (event: AiReviewEvent) => void

const BATCH_RETRY_LIMIT = 2
const BATCH_RETRY_BASE_DELAY_MS = 2000
/** 可重试判定：状态码与 errors.ts 同策略锚定「模型接口返回 NNN」前缀（裸数字会误匹配
 *  端口号等同形子串，如 ECONNREFUSED 127.0.0.1:5023），并补 504 与 errors.ts 的
 *  「服务商暂时不可用」口径对齐；网关短语（bad gateway / service unavailable）作为
 *  连接期代理错误的特征词兜底保留 */
const RETRYABLE_ERROR_PATTERN =
  /模型接口返回 (429|50[0234])\b|rate.?limit|too many requests|bad gateway|service unavailable|ECONNRESET|ETIMEDOUT|timeout|超时|过多/i

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 判定错误是否可退避重试（导出供单元测试） */
export function isRetryableNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return RETRYABLE_ERROR_PATTERN.test(message)
}

async function reviewOnce(
  config: AiModelConfig,
  messages: ChatMessage[],
  batch: number,
  onEvent: AiReviewListener | undefined,
  ruleCount: number,
  ruleSetName: string,
  cancel?: ReviewCancelHandle,
): Promise<BatchOutcome> {
  const startedAt = Date.now()
  const runStream = (retryMessages?: ChatMessage[]) =>
    chatCompletionStream(config, retryMessages ?? messages, (stats) => {
      onEvent?.({
        type: 'batchStream',
        batch,
        thinking: stats.answerChars === 0 && stats.reasoningChars > 0,
        answerChars: stats.answerChars,
        reasoningChars: stats.reasoningChars,
      })
    }, cancel)
  const first = await runStream()
  try {
    return {
      result: parseReviewContent(first.content, config.model, ruleCount, ruleSetName),
      answerChars: first.answerChars,
      reasoningChars: first.reasoningChars,
      usage: first.usage,
      elapsedMs: Date.now() - startedAt,
    }
  } catch {
    onEvent?.({ type: 'batchRetry', batch, reason: 'format' })
    const retry = await runStream([
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          '你的上一条输出不是合法 JSON。请重新输出，内容必须是一个可直接解析的 JSON 对象，不要包含任何其他文字或代码块标记。',
      },
    ])
    const combined = {
      answerChars: first.answerChars + retry.answerChars,
      reasoningChars: first.reasoningChars + retry.reasoningChars,
      usage: mergeUsage(first.usage, retry.usage),
      elapsedMs: Date.now() - startedAt,
    }
    try {
      return {
        result: parseReviewContent(retry.content, config.model, ruleCount, ruleSetName),
        ...combined,
      }
    } catch {
      return {
        result: {
          summary: first.content.trim() || '（模型未返回有效内容）',
          riskLevel: 'medium',
          issues: [],
          degraded: true,
          reviewedAt: Date.now(),
          model: config.model,
          ruleCount,
          ruleSetName,
        },
        ...combined,
      }
    }
  }
}

async function reviewBatchWithRetry(
  config: AiModelConfig,
  messages: ChatMessage[],
  batch: number,
  onEvent: AiReviewListener | undefined,
  ruleCount: number,
  ruleSetName: string,
  cancel: ReviewCancelHandle | undefined,
  logDir: string,
): Promise<BatchOutcome> {
  let attempt = 0
  for (;;) {
    if (cancel?.cancelled) throw new ReviewCancelledError()
    try {
      return await reviewOnce(config, messages, batch, onEvent, ruleCount, ruleSetName, cancel)
    } catch (err) {
      if (isReviewCancelled(err)) throw err
      if (cancel?.cancelled) throw new ReviewCancelledError()
      if (attempt >= BATCH_RETRY_LIMIT || !isRetryableNetworkError(err)) {
        logAiError(logDir, `AI 评审（第 ${batch} 批）`, err, config.model)
        throw err
      }
      attempt += 1
      const waitMs = BATCH_RETRY_BASE_DELAY_MS * attempt
      onEvent?.({ type: 'batchRetry', batch, reason: 'network', waitMs })
      await delay(waitMs)
    }
  }
}

/**
 * 构建批次计划指纹：模型标识 + 评审模式 + 规则集 + 批次总数
 * + 各批次文件路径序列与 diff 片段长度、内容 FNV-1a 短哈希。断点续跑前比对：一致才允许继续分析，
 * 失配（换模型/换模式/换规则集/PR 内容变化）即作废断点从头评审，保证批次间与复核的一致性。
 * 分片内容必须纳入哈希：仅凭长度无法识别等长修改（同长度替换文本/改等长标识符会得出相同长度），
 * 内容任何变化都会改变哈希使指纹失配；哈希碰撞需同时满足路径/分块序号/长度一致，32 位空间内概率可忽略。
 * batchPlan：已构建的批次计划，传入则直接复用——评审启动流程先用同一份 plan 算指纹再传给 reviewPullRequest
 * 执行，避免双重构建（大 PR 下分块与全量内容哈希是显著同步开销）；未传时自行构建，独立调用语义不变。
 */
export function buildResumeFingerprint(
  config: AiModelConfig,
  pr: PullRequestDetail,
  mode: AiReviewMode,
  ruleSetName: string,
  rules: ReviewRule[],
  batchPlan?: BatchPlan,
): string {
  const plan = batchPlan ?? buildBatchPlan(pr, mode)
  const parts: string[] = [
    `${config.baseUrl}#${config.model}`,
    mode,
    ruleSetName,
    JSON.stringify(rules),
    String(plan.batches.length),
  ]
  for (const batch of plan.batches) {
    parts.push(
      batch.chunks
        .map((c) => `${c.file.path}#${c.part}/${c.totalParts}:${c.content.length}#${shortHash(c.content)}`)
        .join('|'),
    )
  }
  return parts.join('\n')
}

/** reviewPullRequest 的可选参数集：除 config/pr 外全部收敛于此，避免长位置参数传错顺序 */
export interface ReviewPullRequestOptions {
  rules: ReviewRule[]
  ruleSetName: string
  onEvent?: AiReviewListener
  cancel?: ReviewCancelHandle
  /** 上次评审结果：提供且有效时，本次评审将逐条核对其问题的修复情况 */
  previous?: AiReviewResult
  /** 分析模式：budget=预算优先，full=全量分析（缺省 budget） */
  mode?: AiReviewMode
  /** 历史误报豁免记录（豁免类治理记录）：注入提示词要求模型不再报告，并在提示词层面与团队规范区分 */
  exempt?: GovernanceRecord[]
  /** 文件全文取证通道：提供后对报过问题的文件执行第二遍对抗式复核（无则跳过复核） */
  fetchFileContent?: FileContentFetcher
  /** 断点续跑：批次号（从 1 开始）→ 已完成批次的结果；命中的批次不重新调用模型、不触发批次事件 */
  completed?: Map<number, AiReviewResult>
  /** 已构建的批次计划：传入则直接复用，避免与指纹计算双重构建；未传时自行构建 */
  batchPlan?: BatchPlan
}

/** 评审主入口：分批评审（并发 + 重试降级）→ 第二遍对抗式复核 → 跨批合并闭环，进度经 onEvent 事件流上报 */
export async function reviewPullRequest(
  config: AiModelConfig,
  pr: PullRequestDetail,
  {
    rules,
    ruleSetName,
    onEvent,
    cancel,
    previous,
    mode = 'budget',
    exempt = [],
    fetchFileContent,
    completed,
    batchPlan,
  }: ReviewPullRequestOptions,
): Promise<AiReviewResult> {
  const startedAt = Date.now()
  const logDir = pr.key.startsWith('local:') ? localLogDir(pr.repo) : remoteLogDir(pr.platform, pr.repo)
  const plan = batchPlan ?? buildBatchPlan(pr, mode)
  const totalBatches = plan.batches.length
  const analyzedFiles = new Set(
    plan.batches.flatMap((b) => b.chunks.map((c) => c.file.path)),
  ).size
  onEvent?.({
    type: 'plan',
    mode,
    totalFiles: pr.files.length,
    analyzedFiles,
    excludedFiles: plan.excluded.length,
    batches: totalBatches,
  })
  if (totalBatches === 0) {
    onEvent?.({
      type: 'done',
      elapsedMs: Date.now() - startedAt,
      sentChars: 0,
      answerChars: 0,
      reasoningChars: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    })
    return {
      summary: '本次变更没有可分析的文本 diff（可能全部为二进制文件或空变更），无法进行 AI 评审。',
      riskLevel: 'low',
      issues: [],
      degraded: true,
      reviewedAt: Date.now(),
      model: config.model,
      ruleCount: rules.length,
      ruleSetName,
    }
  }
  const manifest = buildManifest(plan)
  const multi = totalBatches > 1
  const hasPrevious = Boolean(previous && !previous.degraded && previous.issues.length > 0)
  const prompts: ChatMessage[][] = plan.batches.map((batch, i) => {
    const batchPaths = new Set(batch.chunks.map((c) => c.file.path))
    const previousIssues =
      hasPrevious && previous ? previous.issues.filter((issue) => batchPaths.has(issue.file)) : []
    return [
      { role: 'system', content: buildSystemPrompt(multi, previousIssues.length > 0) },
      {
        role: 'user',
        content: buildBatchPrompt(
          pr,
          rules,
          manifest,
          batch,
          i,
          totalBatches,
          previousIssues,
          exempt,
        ),
      },
    ]
  })
  const completedBatches = completed ?? new Map<number, AiReviewResult>()
  const prefixChars: number[] = []
  let sentChars = 0
  for (const [i, messages] of prompts.entries()) {
    // 断点续跑命中的批次不重发提示词，不计入累计已发送字数：与 done 事件的 sentChars
    // 口径一致（同样排除 completedBatches），否则续跑场景 batchStart 进度虚高
    if (!completedBatches.has(i + 1)) {
      sentChars += messages[0].content.length + messages[1].content.length
    }
    prefixChars.push(sentChars)
  }
  const concurrency = effectiveConcurrency(config, totalBatches)
  const results: AiReviewResult[] = new Array(totalBatches)
  let answerChars = 0
  let reasoningChars = 0
  let usage: TokenUsage | undefined

  const runBatch = async (index: number): Promise<void> => {
    const batch = index + 1
    const resumed = completedBatches.get(batch)
    if (resumed) {
      results[index] = resumed
      return
    }
    onEvent?.({ type: 'batchStart', batch, totalBatches, sentChars: prefixChars[index] })
    // 请求日志在确认该批即将真正调用模型时才写入：续跑命中或失败中断/取消后未发起的批次
    // 不会留下误导性的请求记录（请求块与紧随其后的响应/错误块一一对应）
    logAiRequest(`AI 评审（第 ${batch}/${totalBatches} 批）`, config.model, logDir, prompts[index])
    const outcome = await reviewBatchWithRetry(
      config,
      prompts[index],
      batch,
      onEvent,
      rules.length,
      ruleSetName,
      cancel,
      logDir,
    )
    results[index] = outcome.result
    logAiAnswer(
      logDir,
      `AI 评审（第 ${batch}/${totalBatches} 批）`,
      JSON.stringify(outcome.result, null, 2),
    )
    answerChars += outcome.answerChars
    reasoningChars += outcome.reasoningChars
    usage = mergeUsage(usage, outcome.usage)
    onEvent?.({
      type: 'batchDone',
      batch,
      elapsedMs: outcome.elapsedMs,
      answerChars: outcome.answerChars,
      reasoningChars: outcome.reasoningChars,
      usage: outcome.usage,
      /** 批次结果随事件带回：store 逐批写入断点（resumePoints），失败后续跑免重复计费 */
      result: outcome.result,
    })
  }

  let nextIndex = 0
  let aborted = false
  const workers: Promise<void>[] = []
  for (let worker = 0; worker < concurrency; worker += 1) {
    workers.push(
      (async () => {
        for (;;) {
          if (aborted || cancel?.cancelled) return
          const index = nextIndex
          if (index >= totalBatches) return
          nextIndex += 1
          try {
            await runBatch(index)
          } catch (err) {
            aborted = true
            throw err
          }
        }
      })(),
    )
  }
  // 等待全部 worker 结束而非首个失败即返回：在途批次的请求、日志与事件在本函数内收尾，
  // 避免抛错后在途请求继续在后台消耗配额、发射 batchDone 与下一轮评审事件交错
  const settled = await Promise.allSettled(workers)
  // 用户取消时 worker 走优雅退出（不抛错），results 留有未执行批次的空洞：
  // 进入复核/合并前必须先行拦截，否则下游遍历 results 会踩到 undefined
  if (cancel?.cancelled) throw new ReviewCancelledError()
  const firstRejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (firstRejected) throw firstRejected.reason

  const verifyOutcome = await verifyIssues(
    config,
    results,
    onEvent,
    cancel,
    logDir,
    new Set(pr.files.map((f) => f.path)),
    fetchFileContent,
  )
  const merged = await mergeResults(config, results, previous, onEvent, cancel, logDir)
  if (verifyOutcome) merged.result.verify = verifyOutcome.stat
  onEvent?.({
    type: 'done',
    elapsedMs: Date.now() - startedAt,
    sentChars: prompts.reduce(
      (sum, messages, i) =>
        completedBatches.has(i + 1)
          ? sum
          : sum + messages[0].content.length + messages[1].content.length,
      0,
    ),
    answerChars:
      answerChars + merged.answerChars + (verifyOutcome?.contribution.answerChars ?? 0),
    reasoningChars:
      reasoningChars +
      merged.reasoningChars +
      (verifyOutcome?.contribution.reasoningChars ?? 0),
    usage: mergeUsage(mergeUsage(usage, merged.usage), verifyOutcome?.contribution.usage),
  })
  return merged.result
}
