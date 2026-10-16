import { describe, expect, it } from 'vitest'
import { issueFingerprint, issueFingerprints, looseIssueFingerprint } from '../issueFingerprint'
import type { AiIssue } from '../../types/ai'

/** 构造完整 AiIssue：指纹函数参数为 Pick<AiIssue,'file'|'comment'>，传入完整对象以验证多余字段（行号、严重度等）不参与匹配 */
function issue(overrides: Partial<AiIssue> & Pick<AiIssue, 'comment'>): AiIssue {
  return { file: 'a.ts', line: 1, severity: 'high', type: 'bug', ...overrides }
}

/** 问题指纹（精确）：文件路径 + 压缩空白后的描述，行号不参与——治理记录与「上轮已报」角标跨分析匹配的唯一身份键 */
describe('issueFingerprint', () => {
  it('正常路径：文件与描述拼接为「file|comment」格式', () => {
    expect(issueFingerprint(issue({ file: 'src/a.ts', comment: '空指针风险' }))).toBe(
      'src/a.ts|空指针风险',
    )
  })

  it('行号漂移不参与匹配：同文件同描述、行号不同则指纹一致', () => {
    const before = issueFingerprint(issue({ file: 'src/a.ts', line: 10, comment: '空指针风险' }))
    const after = issueFingerprint(issue({ file: 'src/a.ts', line: 42, comment: '空指针风险' }))
    expect(before).toBe(after)
  })

  it('空白归一化：连续空白与换行压缩为单个空格并去除首尾', () => {
    expect(issueFingerprint(issue({ comment: '  空  指针\n风险 \t描述 ' }))).toBe(
      'a.ts|空 指针 风险 描述',
    )
  })

  it('负向路径：压缩后描述或文件不同则指纹不同', () => {
    expect(issueFingerprint(issue({ comment: '空指针' }))).not.toBe(
      issueFingerprint(issue({ comment: '空指针风险' })),
    )
    expect(issueFingerprint(issue({ comment: 'x' }))).not.toBe(
      issueFingerprint(issue({ file: 'b.ts', comment: 'x' })),
    )
  })
})

/** 宽松指纹（P1-15①）：文件 + 类型 + 行号桶，描述文本不参与——措辞漂移时治理匹配的兜底身份键 */
describe('looseIssueFingerprint', () => {
  it('正常路径：格式为 loose:file|type|bucket 明文，同文件同类型同行号桶一致', () => {
    const a = looseIssueFingerprint(issue({ line: 7, type: 'bug', comment: 'x' }))
    const b = looseIssueFingerprint(issue({ line: 7, type: 'bug', comment: 'x' }))
    expect(a).toBe(b)
    expect(a).toBe('loose:a.ts|bug|1') // 行 7 → 桶 floor(6/5)=1
  })

  it('措辞漂移命中：同文件同类型同位置、描述完全不同 → 宽松指纹一致（核心场景）', () => {
    const original = issue({ line: 12, type: 'bug', comment: '存在空指针解引用风险' })
    const reworded = issue({ line: 12, type: 'bug', comment: '此处可能 NPE，建议判空' })
    expect(looseIssueFingerprint(original)).toBe(looseIssueFingerprint(reworded))
    expect(issueFingerprint(original)).not.toBe(issueFingerprint(reworded)) // 精确指纹失配
  })

  it('行号桶容差：±2 行内小漂移大概率同桶（桶宽 5），跨桶边界除外', () => {
    // 桶内漂移：行 6/7/8/9/10 同属桶 1
    const base = looseIssueFingerprint(issue({ line: 8, type: 'bug', comment: 'x' }))
    expect(looseIssueFingerprint(issue({ line: 6, type: 'bug', comment: 'x' }))).toBe(base)
    expect(looseIssueFingerprint(issue({ line: 10, type: 'bug', comment: 'y' }))).toBe(base)
    // 跨桶边界：行 5（桶 0）与行 6（桶 1）不同——宁漏拦不误拦，接受此误差
    expect(looseIssueFingerprint(issue({ line: 5, type: 'bug', comment: 'x' }))).not.toBe(base)
  })

  it('负向隔离：文件、类型、行号桶任一不同则宽松指纹不同', () => {
    const base = looseIssueFingerprint(issue({ file: 'a.ts', line: 7, type: 'bug', comment: 'x' }))
    expect(
      looseIssueFingerprint(issue({ file: 'b.ts', line: 7, type: 'bug', comment: 'x' })),
    ).not.toBe(base)
    expect(looseIssueFingerprint(issue({ line: 7, type: 'security', comment: 'x' }))).not.toBe(base)
    expect(looseIssueFingerprint(issue({ line: 17, type: 'bug', comment: 'x' }))).not.toBe(base) // 桶 1 vs 桶 3
  })

  it('脏数据行号：非有限、小于 1 的行号（0/负数/0~1 小数）归哨兵桶 -1，与真实桶 0（行 1~5）隔离不误撞（P1-15①评审 #20）', () => {
    const zero = looseIssueFingerprint(issue({ line: 0, comment: 'x' }))
    expect(looseIssueFingerprint(issue({ line: -3, comment: 'y' }))).toBe(zero)
    expect(looseIssueFingerprint(issue({ line: 0.5, comment: 'z' }))).toBe(zero) // floor(-0.1)=-1 的历史 bug 回归
    expect(looseIssueFingerprint(issue({ line: 0.99, comment: 'w' }))).toBe(zero)
    expect(looseIssueFingerprint(issue({ line: Number.NaN, comment: 'v' }))).toBe(zero)
    expect(zero).toBe('loose:a.ts|bug|-1') // 哨兵桶 -1：真实行号 floor((line-1)/5)>=0 恒不产生
    // 误拦回归（评审 #20 核心）：真实行 1~5 的问题不与脏行号问题互撞
    expect(looseIssueFingerprint(issue({ line: 1, comment: '真问题' }))).not.toBe(zero)
    expect(looseIssueFingerprint(issue({ line: 5, comment: '真问题' }))).not.toBe(zero)
  })

  it('issueFingerprints：双指纹单源返回，与单独计算结果一致', () => {
    const i = issue({ file: 'src/x.ts', line: 12, type: 'bug', comment: '风险' })
    const dual = issueFingerprints(i)
    expect(dual.exact).toBe(issueFingerprint(i))
    expect(dual.loose).toBe(looseIssueFingerprint(i))
  })
})

