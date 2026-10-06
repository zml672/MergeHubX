// @vitest-environment node
// buildCommitContext 的摘录预算与行边界对齐；提交说明输出的规范化与首行格式校验
import { describe, expect, it } from 'vitest'
import {
  buildCommitContext,
  isConventionalCommitFirstLine,
  normalizeCommitMessageOutput,
} from '../ai/commit'
import type { DiffFile } from '../../types/platform'

function file(patch: string, path = 'a.ts'): DiffFile {
  return { path, status: 'modified', additions: 5, deletions: 1, patch }
}

describe('buildCommitContext', () => {
  it('正常路径：预算内的小 patch 原样进入摘录，路径行带状态统计', () => {
    const ctx = buildCommitContext([file('@@ -1,2 +1,3 @@\n+新增行\n')])
    expect(ctx).toContain('a.ts（修改，+5/-1）')
    expect(ctx).toContain('+新增行')
  })

  it('截断对齐：预算切点落在行中间时回退到最近换行，摘录以完整行收尾', () => {
    const patch = `${'x'.repeat(100)}\n`.repeat(30) // 每行 101 字符，预算 1200 → 硬切点在第 12 行中间
    const ctx = buildCommitContext([file(patch)])
    const excerpt = ctx.slice(ctx.indexOf('\n') + 1) // 跳过路径行
    expect(excerpt.length).toBeLessThanOrEqual(1200)
    expect(excerpt.endsWith('\n')).toBe(true) // 以完整行收尾，无残缺行
    expect(excerpt.split('\n')).toHaveLength(12) // 11 行内容 + 末尾换行产生的空段
  })

  it('脏数据路径：单行超长 patch 无换行可对齐，退化为硬切', () => {
    const ctx = buildCommitContext([file('y'.repeat(5000))])
    const excerpt = ctx.slice(ctx.indexOf('\n') + 1)
    expect(excerpt).toHaveLength(1200)
  })

  it('全局预算：前一个文件对齐后按实际长度扣减，后续文件在剩余预算内完整保留', () => {
    const longPatch = `${'x'.repeat(100)}\n`.repeat(30)
    const ctx = buildCommitContext([file(longPatch, 'a.ts'), file('small change\n', 'b.ts')])
    expect(ctx).toContain('b.ts（修改，+5/-1）')
    expect(ctx).toContain('small change\n')
  })
})

describe('isConventionalCommitFirstLine', () => {
  it.each([
    'fix: 修复空指针',
    'feat(auth): 新增登录验证',
    'refactor!: 调整内部结构',
    'feat(api)!: 重构接口签名',
    'chore: 同步依赖版本\n\n- 要点一',
  ])('合规首行通过：%s', (text) => {
    expect(isConventionalCommitFirstLine(text)).toBe(true)
  })

  it.each([
    '修复空指针', // 缺 type
    '修复：空指针问题', // 中文冒号
    'Fix: 修复空指针', // 大写 type
    'feature: 新增导出', // 非法 type 关键字
    'fix:修复空指针', // 冒号后缺空格（校验层不归一，归一是 normalize 的职责）
    '', // 空输出
  ])('不合规首行拒绝：%s', (text) => {
    expect(isConventionalCommitFirstLine(text)).toBe(false)
  })
})

describe('normalizeCommitMessageOutput', () => {
  it('剥除包裹整体输出的代码围栏', () => {
    const output = normalizeCommitMessageOutput('```text\nfix: 修复空指针\n```\n')
    expect(output).toBe('fix: 修复空指针')
  })

  it('中文冒号归一为「type: 」且保留原描述', () => {
    expect(normalizeCommitMessageOutput('fix：修复空指针问题')).toBe('fix: 修复空指针问题')
  })

  it('冒号前多余空格一并归一', () => {
    expect(normalizeCommitMessageOutput('feat : 新增导出功能')).toBe('feat: 新增导出功能')
  })

  it('正文前缺空行时自动补上（body-leading-blank 兜底保留）', () => {
    const output = normalizeCommitMessageOutput('fix: 修复空指针\n- 增加判空\n- 补充单测')
    expect(output).toBe('fix: 修复空指针\n\n- 增加判空\n- 补充单测')
  })

  it('已有空行与正文时不重复插入', () => {
    const output = normalizeCommitMessageOutput('fix: 修复空指针\n\n- 增加判空')
    expect(output).toBe('fix: 修复空指针\n\n- 增加判空')
  })

  it('缺 type 的输出不做臆测改写，原样透传（交给调用方重试）', () => {
    const output = normalizeCommitMessageOutput('修复空指针问题\n\n- 增加判空')
    expect(output.startsWith('修复空指针问题')).toBe(true)
  })
})
