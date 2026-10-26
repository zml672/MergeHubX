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

describe('核对结论按行号证据取信（重复报错根治）', () => {
  /** 复现场景：storage.ts 上轮报了 line=540 的问题；本轮 diff 切两段，
   *  批一只含前段（1-300 行），批二含尾段（含 540 行）。批一盲猜 not_fixed，
   *  批二亲眼核对 fixed——修复结论必须胜出，否则已修复问题被无限重报 */
  const coverage: Parameters<typeof mergeResults>[6] = [
    { ranges: new Map([['storage.ts', [[1, 300] as [number, number]]]]) },
    { ranges: new Map([['storage.ts', [[301, 600] as [number, number]]]]) },
  ]
  const blindView: AiPreviousCheck = {
    file: 'storage.ts',
    line: 540,
    severity: 'high',
    type: 'bug',
    comment: '指针切换后尾段目录未建',
    status: 'not_fixed',
    note: '本批次 diff 未包含尾段',
  }
  const evidenceView: AiPreviousCheck = {
    ...blindView,
    status: 'fixed',
    note: '已确认修复',
  }

  it('覆盖批次 fixed 压过盲批 not_fixed：修复结论不再被悲观覆盖', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    const blind: AiReviewResult = { ...batchResult('批一'), previousChecks: [blindView] }
    const evidence: AiReviewResult = { ...batchResult('批二'), previousChecks: [evidenceView] }
    const merged = await mergeResults(config, [blind, evidence], undefined, undefined, undefined, undefined, coverage)
    expect(merged.result.previousChecks).toHaveLength(1)
    expect(merged.result.previousChecks![0].status).toBe('fixed')
    // 闭环不派生：fixed 不是补入条件，已修复问题不再回灌问题清单
    expect(merged.result.issues.some((i) => i.comment === '指针切换后尾段目录未建')).toBe(false)
  })

  it('证据同级（双盲）：退回悲观策略，未修复结论不被乐观掩盖', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    // 两批都覆盖不到 540 行（各自只看到 1-300、301-500 之外的前段），双双盲猜——保留更悲观的
    const bothBlind: Parameters<typeof mergeResults>[6] = [
      { ranges: new Map([['storage.ts', [[1, 300] as [number, number]]]]) },
      { ranges: new Map([['storage.ts', [[301, 500] as [number, number]]]]) },
    ]
    const notFixed: AiReviewResult = { ...batchResult('批一'), previousChecks: [blindView] }
    const optimistic: AiReviewResult = { ...batchResult('批二'), previousChecks: [evidenceView] }
    const merged = await mergeResults(config, [notFixed, optimistic], undefined, undefined, undefined, undefined, bothBlind)
    expect(merged.result.previousChecks![0].status).toBe('not_fixed')
    expect(merged.result.issues.some((i) => i.comment === '指针切换后尾段目录未建')).toBe(true)
  })

  it('不传 coverage：行为与旧版完全一致（纯悲观去重）', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    const fixed: AiReviewResult = { ...batchResult('批一'), previousChecks: [evidenceView] }
    const blind: AiReviewResult = { ...batchResult('批二'), previousChecks: [blindView] }
    const merged = await mergeResults(config, [fixed, blind], undefined, undefined)
    expect(merged.result.previousChecks![0].status).toBe('not_fixed')
  })

  it('line=0 文件级结论视为有证据：任意批次均可判，同级冲突退回悲观', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    const fileLevelBase = { file: 'storage.ts', line: 0, severity: 'medium' as const, type: 'bug' as const, comment: '文件级：错误处理不一致' }
    const batchA: AiReviewResult = {
      ...batchResult('批一'),
      previousChecks: [{ ...fileLevelBase, status: 'fixed', note: '已统一' }],
    }
    const batchB: AiReviewResult = {
      ...batchResult('批二'),
      previousChecks: [{ ...fileLevelBase, status: 'not_fixed', note: '仍不一致' }],
    }
    const merged = await mergeResults(config, [batchA, batchB], undefined, undefined, undefined, undefined, coverage)
    expect(merged.result.previousChecks![0].status).toBe('not_fixed')
  })

  it('清单外回显（模型越权核对未下发文件）：无依据结论不得压过有证据批次的修复结论', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    // 批 1 只覆盖 a.ts（b.ts 的问题清单未下发给它），批 2 覆盖 b.ts。
    // 模型未遵守「只核对下发清单」约束，在批 1 越权回显了 b.ts 的 not_fixed；
    // 批 2 拿到下发清单、真实核对出 fixed。取信必须与分发对称：
    // 文件不在本批覆盖索引 = 无依据，回显的盲猜不得压过有真实依据的 fixed
    const splitCoverage: Parameters<typeof mergeResults>[6] = [
      { ranges: new Map([['a.ts', [[1, 100] as [number, number]]]]) },
      { ranges: new Map([['b.ts', [[1, 100] as [number, number]]]]) },
    ]
    const echoBack: AiPreviousCheck = {
      file: 'b.ts',
      line: 50,
      severity: 'high',
      type: 'bug',
      comment: '指针切换后尾段目录未建',
      status: 'not_fixed',
      note: '清单外回显：本批次 diff 未包含该文件',
    }
    const realVerdict: AiPreviousCheck = { ...echoBack, status: 'fixed', note: '已确认修复' }
    const violator: AiReviewResult = { ...batchResult('批一'), previousChecks: [echoBack] }
    const honest: AiReviewResult = { ...batchResult('批二'), previousChecks: [realVerdict] }
    const merged = await mergeResults(config, [violator, honest], undefined, undefined, undefined, undefined, splitCoverage)
    expect(merged.result.previousChecks![0].status).toBe('fixed')
    expect(merged.result.issues.some((i) => i.comment === '指针切换后尾段目录未建')).toBe(false)
  })

  it('清单外回显 line=0 文件级结论：同样无依据，不得压过覆盖批次的 fixed', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({
      content: '合成后的总评',
      answerChars: 6,
      reasoningChars: 0,
      usage: undefined,
    })
    // line=0 分支残留：文件级结论无位置锚点，但「文件不在本批」的拦截必须优先——
    // 分发端规则④对 line=0 同样「不在不发给」，取信端必须对称
    const splitCoverage: Parameters<typeof mergeResults>[6] = [
      { ranges: new Map([['a.ts', [[1, 100] as [number, number]]]]) },
      { ranges: new Map([['b.ts', [[1, 100] as [number, number]]]]) },
    ]
    const echoFileLevel: AiPreviousCheck = {
      file: 'b.ts',
      line: 0,
      severity: 'medium',
      type: 'bug',
      comment: '文件级：错误处理不一致',
      status: 'not_fixed',
      note: '清单外回显',
    }
    const realFileLevel: AiPreviousCheck = { ...echoFileLevel, status: 'fixed', note: '已核对统一' }
    const violator: AiReviewResult = { ...batchResult('批一'), previousChecks: [echoFileLevel] }
    const honest: AiReviewResult = { ...batchResult('批二'), previousChecks: [realFileLevel] }
    const merged = await mergeResults(config, [violator, honest], undefined, undefined, undefined, undefined, splitCoverage)
    expect(merged.result.previousChecks![0].status).toBe('fixed')
    expect(merged.result.issues.some((i) => i.comment === '文件级：错误处理不一致')).toBe(false)
  })
})
