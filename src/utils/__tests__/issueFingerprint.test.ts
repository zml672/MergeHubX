import { describe, expect, it } from 'vitest'
import { issueFingerprint } from '../issueFingerprint'
import type { AiIssue } from '../../types/ai'

/** 构造完整 AiIssue：指纹函数参数为 Pick<AiIssue,'file'|'comment'>，传入完整对象以验证多余字段（行号、严重度等）不参与匹配 */
function issue(overrides: Partial<AiIssue> & Pick<AiIssue, 'comment'>): AiIssue {
  return { file: 'a.ts', line: 1, severity: 'high', type: 'bug', ...overrides }
}

/** 问题指纹：文件路径 + 压缩空白后的描述，行号不参与——治理记录与「上轮已报」角标跨分析匹配的唯一身份键 */
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
