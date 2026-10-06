// @vitest-environment node
// mergeResults 依赖 chatCompletionStream 发起模型调用，此处 mock 掉 client 模块直测编排逻辑：
// 总评合成成功 / 合成失败降级拼接并标记 degraded / 用户取消直接中断 / 单批次不经合成
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dedupeAndSortIssues, mergeResults } from '../ai/merge'
import { chatCompletionStream, ReviewCancelledError } from '../ai/client'
import type { AiIssue, AiModelConfig, AiPreviousCheck, AiReviewResult } from '../../types/ai'

vi.mock('../ai/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletionStream: vi.fn(),
}))

const config: AiModelConfig = { baseUrl: 'https://api.test.com/v1', model: 'model-x', apiKey: 'k' }

function batchResult(summary: string): AiReviewResult {
  return {
    summary,
    riskLevel: 'low',
    issues: [],
    degraded: false,
    reviewedAt: Date.now(),
    model: 'model-x',
    ruleCount: 0,
  }
}

beforeEach(() => {
  vi.mocked(chatCompletionStream).mockReset()
})

describe('mergeResults', () => {
  it('正常路径：多批次总评由模型连贯合成，degraded 不被误标', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    const merged = await mergeResults(config, [batchResult('批一'), batchResult('批二')], undefined, undefined)
    expect(merged.result.summary).toBe('合成后的总评')
    expect(merged.result.degraded).toBe(false)
    expect(merged.result.issues).toEqual([])
  })

  it('降级路径：总评合成失败降级为分批拼接，degraded 标记合成失败', async () => {
    vi.mocked(chatCompletionStream).mockRejectedValue(new Error('合成调用失败'))
    const merged = await mergeResults(config, [batchResult('批一'), batchResult('批二')], undefined, undefined)
    expect(merged.result.summary).toBe('【批次1】批一\n【批次2】批二')
    expect(merged.result.degraded).toBe(true)
  })

  it('取消路径：总评合成被用户取消时直接中断，不做拼接降级', async () => {
    vi.mocked(chatCompletionStream).mockRejectedValue(new ReviewCancelledError())
    await expect(
      mergeResults(config, [batchResult('批一'), batchResult('批二')], undefined, undefined),
    ).rejects.toThrow('评审已手动停止')
  })

  it('单批次：不经合成直接闭环返回，模型客户端零调用', async () => {
    const merged = await mergeResults(config, [batchResult('唯一批')], undefined, undefined)
    expect(merged.result.summary).toBe('唯一批')
    expect(merged.result.degraded).toBe(false)
    expect(chatCompletionStream).not.toHaveBeenCalled()
  })
})

describe('dedupeAndSortIssues', () => {
  it('同键合并取更严重评级，comment 取更长，结果按严重度升序排序', () => {
    const issues: AiIssue[] = [
      { file: 'a.ts', line: 5, severity: 'low', type: 'bug', comment: '简述' },
      { file: 'a.ts', line: 5, severity: 'high', type: 'bug', comment: '更详细的描述文本' },
      { file: 'b.ts', line: 1, severity: 'medium', type: 'performance', comment: '性能问题' },
    ]
    const merged = dedupeAndSortIssues(issues)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      file: 'a.ts',
      line: 5,
      severity: 'high',
      comment: '更详细的描述文本',
    })
    expect(merged[1]).toMatchObject({ file: 'b.ts', severity: 'medium' })
  })
})

describe('previousChecks 去重与 riskLevel 校准', () => {
  const prevCheck: AiPreviousCheck = {
    file: 'x.ts',
    line: 1,
    severity: 'high',
    type: 'bug',
    comment: '未修复的严重问题',
    status: 'not_fixed',
    note: '仍未修',
  }

  it('多批次：previousChecks 跨批重复时按指纹去重，对比清单不出现重复条目', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    const batchA: AiReviewResult = { ...batchResult('批一'), previousChecks: [prevCheck] }
    const batchB: AiReviewResult = { ...batchResult('批二'), previousChecks: [{ ...prevCheck }] }
    const merged = await mergeResults(config, [batchA, batchB], undefined, undefined)
    expect(merged.result.previousChecks).toHaveLength(1)
  })

  it('riskLevel 校准：闭环补入 high 问题而模型评 low 时，整体风险抬升至 high（多批）', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    const lowBatch: AiReviewResult = {
      ...batchResult('批一'),
      riskLevel: 'low',
      previousChecks: [prevCheck],
    }
    const merged = await mergeResults(
      config,
      [lowBatch, { ...lowBatch, summary: '批二' }],
      undefined,
      undefined,
    )
    expect(merged.result.riskLevel).toBe('high')
    expect(merged.result.issues.some((i) => i.severity === 'high')).toBe(true)
  })

  it('riskLevel 校准：单批次路径同规', async () => {
    const single: AiReviewResult = {
      ...batchResult('唯一批'),
      riskLevel: 'low',
      previousChecks: [prevCheck],
    }
    const merged = await mergeResults(config, [single], undefined, undefined)
    expect(merged.result.riskLevel).toBe('high')
  })

  it('跨批结论冲突：同一核对结论保留更悲观状态，乐观 fixed 不掩盖实际未修复', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    // 批一只扫到文件前段，乐观判 fixed；批二覆盖实际代码，判 not_fixed
    const fixedView: AiPreviousCheck = { ...prevCheck, status: 'fixed' }
    const notFixedView: AiPreviousCheck = { ...prevCheck, status: 'not_fixed', note: '批二实际看到未修复' }
    const batchA: AiReviewResult = { ...batchResult('批一'), previousChecks: [fixedView] }
    const batchB: AiReviewResult = { ...batchResult('批二'), previousChecks: [notFixedView] }
    const merged = await mergeResults(config, [batchA, batchB], undefined, undefined)
    // 去重保留悲观结论，闭环不被绕过：not_fixed 派生补入 issues 并校准风险等级
    expect(merged.result.previousChecks).toHaveLength(1)
    expect(merged.result.previousChecks![0].status).toBe('not_fixed')
    expect(merged.result.issues.some((i) => i.severity === 'high' && i.comment === '未修复的严重问题')).toBe(true)
    expect(merged.result.riskLevel).toBe('high')
  })
})
