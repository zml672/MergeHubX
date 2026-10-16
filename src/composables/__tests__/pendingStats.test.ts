// @vitest-environment node
// P1-15③ 本轮新增待处理指标的纯函数口径测试：
// pending = 总意见 − 豁免命中 − 上轮已修复确认；豁免优先于已修复不双计
// pendingNoteOf：附注文案仅拼计数 >0 的片段（评审 #24）
import { describe, expect, it } from 'vitest'
import { pendingIssueStatsOf, pendingNoteOf } from '../useAiReviewFlow'
import { issueFingerprints } from '../../utils/issueFingerprint'
import type { AiIssue, AiIssueStatus } from '../../types/ai'

let seq = 0
function issue(overrides: Partial<AiIssue>): AiIssue {
  return {
    file: 'src/a.ts',
    line: 3,
    severity: 'medium',
    type: 'bug',
    comment: `问题 ${seq += 1}`,
    ...overrides,
  }
}

/** 生产口径复刻：豁免=精确指纹在豁免集合；已修复=精确指纹在 fixed 集合（与 prevStatusIndex 同构） */
function harness(
  issues: AiIssue[],
  exemptIssues: AiIssue[],
  fixedIssues: AiIssue[],
): ReturnType<typeof pendingIssueStatsOf> {
  const exemptKeys = new Set(exemptIssues.map((i) => issueFingerprints(i).exact))
  const fixedKeys = new Set(fixedIssues.map((i) => issueFingerprints(i).exact))
  return pendingIssueStatsOf(
    issues,
    (i) => exemptKeys.has(issueFingerprints(i).exact),
    (i) => (fixedKeys.has(issueFingerprints(i).exact) ? ('fixed' satisfies AiIssueStatus) : undefined),
  )
}

describe('pendingIssueStatsOf 本轮新增待处理', () => {
  it('全部为新增：pending 等于总数，fixed/exempt 归零', () => {
    const issues = [issue({}), issue({}), issue({})]
    expect(harness(issues, [], [])).toEqual({ pending: 3, fixed: 0, exempt: 0 })
  })

  it('剔除豁免命中：isExempt 命中的不计入 pending', () => {
    const kept = issue({})
    const exempted = issue({})
    expect(harness([kept, exempted], [exempted], [])).toEqual({ pending: 1, fixed: 0, exempt: 1 })
  })

  it('剔除上轮已修复确认：prevStatusOf 返回 fixed 的不计入 pending', () => {
    const kept = issue({})
    const fixed = issue({})
    expect(harness([kept, fixed], [], [fixed])).toEqual({ pending: 1, fixed: 1, exempt: 0 })
  })

  it('豁免与已修复同时剔除：三类计数各归其位', () => {
    const issues = [issue({}), issue({}), issue({}), issue({})]
    const exempted = issues[0]
    const fixed = issues[1]
    expect(harness(issues, [exempted], [fixed])).toEqual({ pending: 2, fixed: 1, exempt: 1 })
  })

  it('同一条豁免与已修复双重身份只归豁免，不双计', () => {
    const both = issue({})
    const issues = [both, issue({})]
    const stats = harness(issues, [both], [both])
    expect(stats).toEqual({ pending: 1, fixed: 0, exempt: 1 })
    // 减法守恒：pending + fixed + exempt === 总数（双重身份未重复扣减）
    expect(stats.pending + stats.fixed + stats.exempt).toBe(issues.length)
  })

  it('空清单：三项全零', () => {
    expect(pendingIssueStatsOf([], () => false, () => undefined)).toEqual({
      pending: 0,
      fixed: 0,
      exempt: 0,
    })
  })

  it('part 修复与未修复不复述：prevStatusOf 非 fixed 不影响 pending', () => {
    const issues = [issue({}), issue({})]
    const stats = pendingIssueStatsOf(
      issues,
      () => false,
      (i) => (i.line === 3 ? 'partial' : 'not_fixed'),
    )
    expect(stats).toEqual({ pending: 2, fixed: 0, exempt: 0 })
  })
})

describe('pendingNoteOf 附注文案（评审 #24：零计数片段不拼接）', () => {
  it('两类剔除都有：两片段以顿号相连', () => {
    expect(pendingNoteOf({ exempt: 3, fixed: 2 })).toBe('已豁免 3、上轮已修复 2 未计入')
  })

  it('仅豁免（fixed=0）：不出「上轮已修复 0」误导片段', () => {
    const note = pendingNoteOf({ exempt: 5, fixed: 0 })
    expect(note).toBe('已豁免 5')
    expect(note).not.toContain('上轮已修复')
  })

  it('仅已修复（exempt=0）：不出「已豁免 0」片段', () => {
    const note = pendingNoteOf({ exempt: 0, fixed: 4 })
    expect(note).toBe('上轮已修复 4 未计入')
    expect(note).not.toContain('已豁免')
  })

  it('零剔除：返回空串（面板隐藏附注、导出不追加括号）', () => {
    expect(pendingNoteOf({ exempt: 0, fixed: 0 })).toBe('')
  })
})
