// @vitest-environment node
// reviewPullRequest 的请求日志纪律：请求块与真实发生的模型调用一一对应——
// 失败中断后未发起的批次、断点续跑命中的批次都不得预写请求日志
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewPullRequest } from '../ai/engine'
import { logAiRequest } from '../aiDebugLog'
import { chatCompletionStream } from '../ai/client'
import type { AiReviewEvent } from '../ai/engine'
import type { AiModelConfig, ReviewRule } from '../../types/ai'
import type { DiffFile, PullRequestDetail } from '../../types/platform'

vi.mock('../aiDebugLog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logAiRequest: vi.fn(),
}))
vi.mock('../ai/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletionStream: vi.fn(),
}))

const config: AiModelConfig = {
  baseUrl: 'https://api.test.com/v1',
  model: 'model-x',
  apiKey: 'k',
  concurrency: 1,
}
const rules: ReviewRule[] = []

/** 两个各 25KB 无换行 patch 的文件：确定性切成每文件 4 块、共 4 个批次 */
function makeTwoFilePr(): PullRequestDetail {
  const files: DiffFile[] = [
    { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x'.repeat(25 * 1024) },
    { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y'.repeat(25 * 1024) },
  ]
  return {
    key: 'github:o/r#1',
    platform: 'github',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'a',
    state: 'open',
    sourceBranch: 'feature',
    targetBranch: 'main',
    fromFork: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: '',
    body: '',
    additions: 0,
    deletions: 0,
    changedFiles: files.length,
    files,
  }
}

const okResult = {
  content: '{"summary":"s","riskLevel":"low","issues":[]}',
  answerChars: 1,
  reasoningChars: 0,
  usage: undefined,
}

beforeEach(() => {
  vi.mocked(logAiRequest).mockClear()
  vi.mocked(chatCompletionStream).mockReset()
})

describe('reviewPullRequest 请求日志纪律', () => {
  it('首批不可重试失败后，未发起批次的请求日志不再预写', async () => {
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(new Error('模型接口返回 404: not found'))
    await expect(reviewPullRequest(config, makeTwoFilePr(), { rules, ruleSetName: 's' })).rejects.toThrow(
      '模型接口返回 404',
    )
    // 只有真正发起调用的第 1 批写了请求日志；2~4 批从未发起，不应留下记录
    expect(logAiRequest).toHaveBeenCalledTimes(1)
  })

  it('正常完成：每个实际调用的批次恰好对应一条请求日志', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const events: AiReviewEvent[] = []
    await reviewPullRequest(
      config,
      {
        ...makeTwoFilePr(),
        files: [
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
          { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y' },
        ],
      },
      { rules, ruleSetName: 's', onEvent: (e) => events.push(e) },
    )
    // 小 patch 单批完成：一条请求日志对应唯一一次模型调用（无总评合成调用）
    expect(logAiRequest).toHaveBeenCalledTimes(1)
    expect(chatCompletionStream).toHaveBeenCalledTimes(1)
  })

  it('batchDone 事件必须携带批次结果（断点存档的数据源）', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const events: AiReviewEvent[] = []
    await reviewPullRequest(
      config,
      {
        ...makeTwoFilePr(),
        files: [
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
          { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y' },
        ],
      },
      { rules, ruleSetName: 's', onEvent: (e) => events.push(e) },
    )
    const batchDones = events.filter((e) => e.type === 'batchDone')
    expect(batchDones.length).toBeGreaterThan(0)
    for (const event of batchDones) {
      // 断点存档的数据源：缺失该字段会导致断点永远为空、失败后无法续跑
      expect(event.result).toBeDefined()
      expect(event.result?.summary).toBe('s')
    }
  })

  it('断点续跑：命中的批次不写请求日志，仅实际重跑的批次记录', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const resumed = {
      summary: 's',
      riskLevel: 'low' as const,
      issues: [],
      degraded: false,
      reviewedAt: 1,
      model: 'model-x',
      ruleCount: 0,
    }
    await reviewPullRequest(config, makeTwoFilePr(), {
      rules,
      ruleSetName: 's',
      completed: new Map([
        [1, resumed],
        [2, resumed],
      ]),
    })
    // 批次 1~2 命中断点被跳过，仅第 3 批真正调用模型
    expect(logAiRequest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logAiRequest).mock.calls[0][0]).toBe('AI 评审（第 3/3 批）')
  })

  it('断点续跑口径：batchStart 与 done 的 sentChars 同样排除命中断点的批次', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const resumed = {
      summary: 's',
      riskLevel: 'low' as const,
      issues: [],
      degraded: false,
      reviewedAt: 1,
      model: 'model-x',
      ruleCount: 0,
    }
    const events: AiReviewEvent[] = []
    await reviewPullRequest(config, makeTwoFilePr(), {
      rules,
      ruleSetName: 's',
      onEvent: (e) => events.push(e),
      completed: new Map([
        [1, resumed],
        [2, resumed],
      ]),
    })
    // 4 批中 1~2 批续跑命中：batchStart 仅第 3 批发出，其 sentChars 只含第 3 批提示词
    // （不把被跳过的 1~2 批前缀计入），与 done 事件排除口径一致
    const starts = events.filter((e) => e.type === 'batchStart')
    expect(starts).toHaveLength(1)
    const done = events.find((e) => e.type === 'done')
    const batch3Sent = done?.sentChars ?? 0
    expect(starts[0].sentChars).toBe(batch3Sent)
    expect(batch3Sent).toBeGreaterThan(0)
  })
})
