// @vitest-environment node
// SSE 流解析的边界行为（末段冲刷、跨块断行）与并发数计算的脏数据兜底
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatCompletionStream, DEFAULT_BATCH_CONCURRENCY, effectiveConcurrency } from '../ai/client'
import { httpStreamRequest } from '../http'
import type { AiModelConfig } from '../../types/ai'

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
