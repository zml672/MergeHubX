/** 模型 HTTP 客户端：OpenAI 兼容端点的非流式/流式聊天补全、SSE 解析、取消与用量统计 */

import { httpRequest, httpStreamRequest } from '../http'
import { extractError } from './errors'
import type { AiModelConfig } from '../../types/ai'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface StreamStats {
  answerChars: number
  reasoningChars: number
}

/** 流式进度快照：字数统计 + 全文实时内容（供进度面板滚动预览） */
export interface StreamProgress extends StreamStats {
  answerText: string
  reasoningText: string
}

export interface StreamResult extends StreamStats {
  content: string
  usage?: TokenUsage
}

export interface ReviewCancelHandle {
  requestId: string
  /** 由 store 在用户点停止时置位；请求失败/退避期间无法走 Rust token 取消，靠此标志阻断重试 */
  cancelled: boolean
}

export class ReviewCancelledError extends Error {
  constructor() {
    super('评审已手动停止')
    this.name = 'ReviewCancelledError'
  }
}

export function isReviewCancelled(err: unknown): boolean {
  return err instanceof ReviewCancelledError
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatResponseShape {
  choices?: { message?: { content?: unknown } }[]
}

interface StreamChunkShape {
  /** 部分兼容端点以 HTTP 200 + SSE data 行下发错误对象（限流/余额不足等），不读取则被静默忽略 */
  error?: {
    code?: unknown
    message?: unknown
  }
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[]
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
}

const CHAT_TIMEOUT_SECS = 120
const TEST_TIMEOUT_SECS = 30

const STREAM_CANCELLED_MARKER = 'HTTP_STREAM_CANCELLED'

/** 批次评审与第二遍复核共用的默认并发数：调大可缩短总耗时，但过大会触发 API 限流 */
export const DEFAULT_BATCH_CONCURRENCY = 2

/** 计算评审/复核的实际并发数，上限为当前待处理单元数。concurrency 来自用户配置，
 *  可能被脏持久化数据污染为非有限值（如 NaN）——NaN 会让 worker 循环零次执行
 *  （复核被静默跳过、批次结果留空洞），故非有限值一律回退默认并发 */
export function effectiveConcurrency(config: AiModelConfig, cap: number): number {
  const raw = config.concurrency
  const base =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BATCH_CONCURRENCY
  return Math.max(1, Math.min(base, cap))
}

function endpointOf(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

function parseUsage(raw: {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
}): TokenUsage | undefined {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0
  const usage: TokenUsage = {
    promptTokens: num(raw.prompt_tokens),
    completionTokens: num(raw.completion_tokens),
    totalTokens: num(raw.total_tokens),
  }
  return usage.totalTokens > 0 ? usage : undefined
}

export function mergeUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage {
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
  }
}

export async function chatCompletion(
  config: AiModelConfig,
  messages: ChatMessage[],
  timeoutSecs = CHAT_TIMEOUT_SECS,
): Promise<string> {
  if (!config.baseUrl) throw new Error('未配置模型接口地址 (Base URL)')
  if (!config.model) throw new Error('未配置模型名称')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  const res = await httpRequest({
    url: endpointOf(config.baseUrl),
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.2,
      stream: false,
    }),
    timeoutSecs,
  })
  if (res.status >= 400) {
    throw new Error(`模型接口返回 ${res.status}: ${extractError(res.body)}`)
  }
  let parsed: ChatResponseShape
  try {
    parsed = JSON.parse(res.body) as ChatResponseShape
  } catch {
    throw new Error('无法解析模型接口响应')
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型返回内容为空')
  }
  return content
}

export async function chatCompletionStream(
  config: AiModelConfig,
  messages: ChatMessage[],
  onStream?: (progress: StreamProgress) => void,
  cancel?: ReviewCancelHandle,
): Promise<StreamResult> {
  if (!config.baseUrl) throw new Error('未配置模型接口地址 (Base URL)')
  if (!config.model) throw new Error('未配置模型名称')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  let answer = ''
  let reasoning = ''
  let buffer = ''
  let usage: TokenUsage | undefined
  /** SSE data 行下发的业务错误（HTTP 层是 200，状态码检查拦不住）：记录后在流结束时抛出 */
  let streamError: string | undefined
  const handleLine = (line: string) => {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!payload || payload === '[DONE]') return
    let chunk: StreamChunkShape
    try {
      chunk = JSON.parse(payload) as StreamChunkShape
    } catch {
      return
    }
    if (chunk.error && typeof chunk.error === 'object') {
      const code =
        typeof chunk.error.code === 'string' || typeof chunk.error.code === 'number'
          ? `(${chunk.error.code}) `
          : ''
      const message =
        typeof chunk.error.message === 'string' && chunk.error.message.trim()
          ? chunk.error.message.trim()
          : '未知错误（流式响应携带 error 对象）'
      streamError = `模型流式响应返回错误 ${code}${message}`
      return
    }
    const delta = chunk.choices?.[0]?.delta
    const content = delta?.content
    if (typeof content === 'string' && content) answer += content
    const think = delta?.reasoning_content
    if (typeof think === 'string' && think) reasoning += think
    if (chunk.usage) {
      // 覆盖式赋值（取最后一次快照）：标准 stream_options.include_usage 仅末尾发一次
      // （覆盖=原值，无影响）；部分网关逐 chunk 携带累计用量快照，取末次即全量——若按
      // mergeUsage 累加会成倍放大。跨批次/跨尝试的用量合并语义不同，仍由 engine/verify
      // 层用 mergeUsage 处理，此处不混用
      const parsed = parseUsage(chunk.usage)
      if (parsed) usage = parsed
    }
  }
  const consume = (text: string) => {
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
    onStream?.({
      answerChars: answer.length,
      reasoningChars: reasoning.length,
      answerText: answer,
      reasoningText: reasoning,
    })
  }
  // 超时兜底由 Rust 侧代理强制（src-tauri/src/commands.rs http_request_stream）：
  // 连接 10s、空闲 90s（连续无新数据即中断，错误含「超时」字样命中重试白名单）、总时长 600s。
  // 流式不适用非流式的固定 CHAT_TIMEOUT_SECS——健康的长时间生成合法超过 120 秒，
  // 流式语义是「空闲 + 总时长」双上限而非固定总时长；因此 JS 侧 Promise 必然 settle，不会永久挂起
  const res = await httpStreamRequest(
    {
      url: endpointOf(config.baseUrl),
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
      }),
    },
    consume,
    cancel?.requestId,
  ).catch((err: unknown) => {
    if (err === STREAM_CANCELLED_MARKER) throw new ReviewCancelledError()
    throw err
  })
  // 流结束冲刷残留 buffer：非规范服务器/代理截断下，最后一个 data 事件可能不带换行符，
  // 不冲刷会静默丢失末段增量内容与最终 usage 统计
  if (buffer) {
    for (const line of buffer.split('\n')) handleLine(line)
    buffer = ''
  }
  if (res.status >= 400) {
    throw new Error(
      `模型接口返回 ${res.status}: ${extractError(res.body ?? answer)}`,
    )
  }
  // SSE 层业务错误优先于空内容检查：HTTP 200 + error 对象的场景若先判空，
  // 真实的限流/余额不足会被「模型返回内容为空」掩盖
  if (streamError) throw new Error(streamError)
  if (!answer.trim()) throw new Error('模型返回内容为空')
  return {
    content: answer,
    answerChars: answer.length,
    reasoningChars: reasoning.length,
    usage,
  }
}

export async function testAiConnection(config: AiModelConfig): Promise<string> {
  return chatCompletion(
    config,
    [{ role: 'user', content: '连接测试，请只回复：连接成功' }],
    TEST_TIMEOUT_SECS,
  )
}
