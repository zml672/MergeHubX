// @vitest-environment node
// SSE 流解析的边界行为（末段冲刷、跨块断行）与并发数计算的脏数据兜底
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatCompletionStream, DEFAULT_BATCH_CONCURRENCY, effectiveConcurrency, effectiveStreamTimeoutSecs } from '../ai/client'
import { httpStreamRequest, type HttpOptions } from '../http'
import { STREAM_TIMEOUT_RANGE, normalizeStreamTimeoutSecs, normalizeThinkingEffort, type AiModelConfig } from '../../types/ai'

vi.mock('../http', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  httpStreamRequest: vi.fn(),
}))

const config: AiModelConfig = { baseUrl: 'https://api.test.com/v1', model: 'model-x', apiKey: 'k' }

function mockStream(chunks: string[]): void {
  vi.mocked(httpStreamRequest).mockImplementation(async (_options, onChunk) => {
    for (const chunk of chunks) onChunk(chunk)
    return { status: 200, headers: {}, body: null }
  })
}

const sse = (delta: object): string => `data: ${JSON.stringify(delta)}`

beforeEach(() => {
  vi.mocked(httpStreamRequest).mockReset()
})

describe('chatCompletionStream SSE 解析', () => {
  it('正常路径：多块增量解析，[DONE] 终止符安全跳过', async () => {
    mockStream([
      `${sse({ choices: [{ delta: { content: '你好' } }] })}\n`,
      `${sse({ choices: [{ delta: { content: '世界' } }] })}\n\n${sse({ choices: [{ delta: {} }] })}\n`,
      'data: [DONE]\n',
    ])
    const res = await chatCompletionStream(config, [{ role: 'user', content: 'hi' }])
    expect(res.content).toBe('你好世界')
  })

  it('流结束冲刷：最后一个 data 事件不带换行符时，增量内容与 usage 不丢失', async () => {
    mockStream([
      `${sse({ choices: [{ delta: { content: '你好' } }] })}\n`,
      `${sse({
        choices: [{ delta: { content: '世界' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}`,
    ])
    const res = await chatCompletionStream(config, [{ role: 'user', content: 'hi' }])
    expect(res.content).toBe('你好世界')
    expect(res.usage?.totalTokens).toBe(15)
  })

  it('跨块断行：SSE 事件被网络分包从中间切开时仍能正确拼接', async () => {
    const full = `${sse({ choices: [{ delta: { content: '分段' } }] })}\n`
    mockStream([full.slice(0, 10), full.slice(10)])
    const res = await chatCompletionStream(config, [{ role: 'user', content: 'hi' }])
    expect(res.content).toBe('分段')
  })

  it('错误状态：status >= 400 抛出含状态码的错误', async () => {
    vi.mocked(httpStreamRequest).mockResolvedValue({ status: 503, headers: {}, body: '服务过载' })
    await expect(chatCompletionStream(config, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      '模型接口返回 503',
    )
  })

  it('SSE 业务错误：HTTP 200 但 data 行携带 error 对象时抛出该错误，不被「内容为空」掩盖', async () => {
    mockStream([
      `${sse({ error: { code: '1302', message: '并发上限或余额不足' } })}\n`,
      'data: [DONE]\n',
    ])
    await expect(chatCompletionStream(config, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      '模型流式响应返回错误 (1302) 并发上限或余额不足',
    )
  })

  it('SSE 业务错误：error 缺 message 时抛出兜底文案，仍优先于空内容误报', async () => {
    mockStream([`${sse({ error: {} })}\n`, 'data: [DONE]\n'])
    await expect(chatCompletionStream(config, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      '未知错误（流式响应携带 error 对象）',
    )
  })

  it('usage 快照语义：逐 chunk 携带累计快照时取末次覆盖，不累加翻倍', async () => {
    mockStream([
      `${sse({ choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } })}\n`,
      `${sse({ choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n`,
      `${sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n`,
      'data: [DONE]\n',
    ])
    const res = await chatCompletionStream(config, [{ role: 'user', content: 'hi' }])
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 5, totalTokens: 105 })
  })

  it('usage 标准语义：include_usage 仅末尾发一次时覆盖即原值，结果不变', async () => {
    mockStream([
      `${sse({ choices: [{ delta: { content: '你好' } }] })}\n`,
      `${sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n`,
      'data: [DONE]\n',
    ])
    const res = await chatCompletionStream(config, [{ role: 'user', content: 'hi' }])
    expect(res.content).toBe('你好')
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })
})

describe('线束 id：取消注册表一对一映射（停止按钮可靠性的根基）', () => {
  const sseOk = `${sse({ choices: [{ delta: { content: 'ok' } }] })}\n`

  it('cancel 句柄携带 streamIds 时：发流登记独立线束 id，settle 后注销', async () => {
    const seenIds: (string | undefined)[] = []
    vi.mocked(httpStreamRequest).mockImplementation(async (_o, onChunk, requestId) => {
      seenIds.push(requestId)
      onChunk(sseOk)
      return { status: 200, headers: {}, body: null }
    })
    const cancel = { requestId: 'req_A', cancelled: false, streamIds: new Set<string>() }
    await chatCompletionStream(config, [{ role: 'user', content: 'hi' }], undefined, cancel)
    expect(seenIds[0]).toMatch(/^req_A#\d+$/)
    expect(cancel.streamIds.size).toBe(0)
  })

  it('同一句柄并发多条流：线束 id 互不相同（Rust 注册表后到覆盖的根治依据）', async () => {
    const seenIds: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.mocked(httpStreamRequest).mockImplementation(async (_o, onChunk, requestId) => {
      seenIds.push(requestId as string)
      if (seenIds.length === 2) release()
      await gate
      onChunk(sseOk)
      return { status: 200, headers: {}, body: null }
    })
    const cancel = { requestId: 'req_B', cancelled: false, streamIds: new Set<string>() }
    await Promise.all([
      chatCompletionStream(config, [{ role: 'user', content: '1' }], undefined, cancel),
      chatCompletionStream(config, [{ role: 'user', content: '2' }], undefined, cancel),
    ])
    expect(seenIds.length).toBe(2)
    expect(new Set(seenIds).size).toBe(2)
  })

  it('无线束集合的句柄（旧调用方）退化为按 requestId 前缀注册，不抛错', async () => {
    const seenIds: (string | undefined)[] = []
    vi.mocked(httpStreamRequest).mockImplementation(async (_o, onChunk, requestId) => {
      seenIds.push(requestId)
      onChunk(sseOk)
      return { status: 200, headers: {}, body: null }
    })
    const cancel = { requestId: 'req_C', cancelled: false }
    await chatCompletionStream(config, [{ role: 'user', content: 'hi' }], undefined, cancel)
    expect(seenIds[0]).toMatch(/^req_C#\d+$/)
  })

  it('取消句柄缺省（如测试连接）时不传线束 id', async () => {
    const seenIds: (string | undefined)[] = []
    vi.mocked(httpStreamRequest).mockImplementation(async (_o, onChunk, requestId) => {
      seenIds.push(requestId)
      onChunk(sseOk)
      return { status: 200, headers: {}, body: null }
    })
    await chatCompletionStream(config, [{ role: 'user', content: 'hi' }])
    expect(seenIds[0]).toBeUndefined()
  })

  it('流抛错（含用户取消）路径同样注销线束 id（finally 语义）', async () => {
    vi.mocked(httpStreamRequest).mockRejectedValue(new Error('HTTP_STREAM_CANCELLED'))
    const cancel = { requestId: 'req_D', cancelled: false, streamIds: new Set<string>() }
    await expect(
      chatCompletionStream(config, [{ role: 'user', content: 'hi' }], undefined, cancel),
    ).rejects.toThrow()
    expect(cancel.streamIds.size).toBe(0)
  })
})

describe('P1-16 思考力度透传（reasoning_effort）', () => {
  const sseOk = `${sse({ choices: [{ delta: { content: 'ok' } }] })}\n`
  /** 抓取发流时的请求体（JSON 字符串） */
  async function capturedBody(cfg: AiModelConfig): Promise<Record<string, unknown>> {
    let body: string | undefined
    vi.mocked(httpStreamRequest).mockImplementation(async (options, onChunk) => {
      body = String(options.body)
      onChunk(sseOk)
      return { status: 200, headers: {}, body: null }
    })
    await chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }])
    return JSON.parse(body ?? '{}') as Record<string, unknown>
  }

  it('缺省不发送：跟随模型默认，请求体不含 reasoning_effort（老配置零影响）', async () => {
    const body = await capturedBody(config)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('显式选档透传：reasoning_effort 携带所选档位，其余请求体字段不受影响', async () => {
    const body = await capturedBody({ ...config, reasoningEffort: 'low' })
    expect(body.reasoning_effort).toBe('low')
    expect(body.model).toBe('model-x')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('normalizeThinkingEffort：合法档位原样返回，枚举外脏值回退 undefined（不发送）', () => {
    expect(normalizeThinkingEffort('low')).toBe('low')
    expect(normalizeThinkingEffort('high')).toBe('high')
    expect(normalizeThinkingEffort('max')).toBe('max')
    expect(normalizeThinkingEffort('medium')).toBeUndefined() // 5.3 系不认的档位不发
    expect(normalizeThinkingEffort('none')).toBeUndefined()
    expect(normalizeThinkingEffort(undefined)).toBeUndefined()
    expect(normalizeThinkingEffort(42)).toBeUndefined()
  })
})

describe('P1-16 延伸：流式总时长上限钳制与透传', () => {
  it('区间内的自定义值生效并向下取整', () => {
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: 1200 })).toBe(1200)
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: 120.9 })).toBe(120)
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: 3600 })).toBe(3600)
  })

  it('缺省与越界/脏值回退默认值：保险丝不可被手滑拆掉', () => {
    const { min, max, default: def } = STREAM_TIMEOUT_RANGE
    expect(effectiveStreamTimeoutSecs(config)).toBe(def)
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: min - 60 })).toBe(def) // 低于下限
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: max + 3600 })).toBe(def) // 高于上限
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: Number.NaN })).toBe(def)
    expect(effectiveStreamTimeoutSecs({ ...config, streamTimeoutSecs: Number.POSITIVE_INFINITY })).toBe(def)
  })

  it('发流请求携带 timeoutSecs：自定义值透传给 Rust，缺省携带默认值', async () => {
    async function capturedOptions(cfg: AiModelConfig): Promise<HttpOptions> {
      let captured: HttpOptions | undefined
      vi.mocked(httpStreamRequest).mockImplementation(async (options, onChunk) => {
        captured = options
        onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n`)
        return { status: 200, headers: {}, body: null }
      })
      await chatCompletionStream(cfg, [{ role: 'user', content: 'hi' }])
      return captured as HttpOptions
    }
    expect((await capturedOptions({ ...config, streamTimeoutSecs: 1800 })).timeoutSecs).toBe(1800)
    expect((await capturedOptions(config)).timeoutSecs).toBe(STREAM_TIMEOUT_RANGE.default)
  })

  it('normalizeStreamTimeoutSecs：区间外整型与非整数回退 undefined（用默认值）', () => {
    const { min, max } = STREAM_TIMEOUT_RANGE
    expect(normalizeStreamTimeoutSecs(1200)).toBe(1200)
    expect(normalizeStreamTimeoutSecs(min - 1)).toBeUndefined() // 低于下限
    expect(normalizeStreamTimeoutSecs(max + 1)).toBeUndefined() // 高于上限
    expect(normalizeStreamTimeoutSecs(600.5)).toBeUndefined() // 非整数
    expect(normalizeStreamTimeoutSecs('1800')).toBeUndefined() // 字符串脏数据
    expect(normalizeStreamTimeoutSecs(undefined)).toBeUndefined()
  })
})

describe('effectiveConcurrency', () => {
  it('正常配置直接生效并受上限约束', () => {
    expect(effectiveConcurrency({ ...config, concurrency: 3 }, 10)).toBe(3)
    expect(effectiveConcurrency({ ...config, concurrency: 8 }, 3)).toBe(3)
  })

  it('非有限值（如 NaN）回退默认并发，避免 worker 循环零次执行', () => {
    expect(effectiveConcurrency({ ...config, concurrency: Number.NaN }, 10)).toBe(
      DEFAULT_BATCH_CONCURRENCY,
    )
  })

  it('小数向下取整，零与负值兜底为 1', () => {
    expect(effectiveConcurrency({ ...config, concurrency: 2.7 }, 10)).toBe(2)
    expect(effectiveConcurrency({ ...config, concurrency: 0 }, 10)).toBe(1)
    expect(effectiveConcurrency({ ...config, concurrency: -5 }, 10)).toBe(1)
  })

  it('缺省配置回退默认并发', () => {
    expect(effectiveConcurrency(config, 10)).toBe(DEFAULT_BATCH_CONCURRENCY)
  })
})
