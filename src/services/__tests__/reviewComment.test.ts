// @vitest-environment node
// 评审汇总评论构建器（R2）：头部统计、unlocatable 偏置、分组排序、幂等标记定位、超限截断
import { describe, expect, it } from 'vitest'
import {
  buildReviewComment,
  findReviewComment,
  reviewCommentMarker,
} from '../ai/reviewComment'
import type { AiIssue, AiReviewResult } from '../../types/ai'

function issue(partial: Partial<AiIssue>): AiIssue {
  return {
    file: 'src/a.ts',
    line: 1,
    severity: 'medium',
    type: 'bug',
    comment: '问题',
    ...partial,
  }
}

function result(partial: Partial<AiReviewResult>): AiReviewResult {
  return {
    summary: '整体分析结论',
    riskLevel: 'medium',
    issues: [],
    degraded: false,
    reviewedAt: 1700000000000,
    model: 'glm-4.7',
    ruleCount: 5,
    ...partial,
  }
}

describe('buildReviewComment 汇总评论构建', () => {
  it('头部携带幂等标记（含仓库与 PR 冗余校验）与风险等级、本轮新增待处理', () => {
    const md = buildReviewComment({
      repo: 'acme/app',
      number: 12,
      result: result({ riskLevel: 'high' }),
    })
    expect(md).toContain('<!-- mergehub-review:v1 acme/app#12 -->')
    expect(md).toContain('高风险')
    expect(md).toContain('本轮新增待处理 0 条**')
  })

  it('pending 附注零片段不拼接（与 pendingNoteOf 口径一致），有豁免时拼接', () => {
    const base = result({ issues: [] })
    const none = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: base,
      pending: { pending: 3, fixed: 0, exempt: 0 },
    })
    expect(none).toContain('**本轮新增待处理 3 条**')
    expect(none).not.toContain('已豁免')
    expect(none).not.toContain('上轮已修复')

    const withNote = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: base,
      pending: { pending: 2, fixed: 1, exempt: 4 },
    })
    expect(withNote).toContain('（已豁免 4、上轮已修复 1 未计入）')
  })

  it('unlocatable 意见不写入正文（偏置原则：公开评论宁缺勿错），并在尾部给出未列入说明', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({
        issues: [
          issue({ comment: '可见问题', line: 10 }),
          issue({ comment: '脏坐标问题', line: 999, locationStatus: 'unlocatable' }),
        ],
      }),
    })
    expect(md).toContain('可见问题')
    expect(md).not.toContain('脏坐标问题')
    expect(md).toContain('另有 1 条意见无法在变更文件中定位坐标')
  })

  it('locationStatus 缺省（旧数据）视为可定位照常写入', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({ issues: [issue({ comment: '旧数据问题' })] }),
    })
    expect(md).toContain('旧数据问题')
  })

  it('引用行与正文之间有空行分隔（评审 #35：懒延续会把紧贴引用行的段落并进引用块渲染）', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({ summary: '整体分析结论' }),
    })
    // > 🤖 引用行后必须紧跟空行（\n\n），否则下一段被 CommonMark 懒延续吞进引用块
    expect(md).toMatch(/> 🤖 [^\n]+\n\n/)
  })

  it('意见按文件分组且组间按最高严重度排序（high 组在前），组内带严重度·类型标签', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({
        issues: [
          issue({ file: 'src/low.ts', severity: 'low', comment: '轻微意见' }),
          issue({ file: 'src/high.ts', severity: 'high', comment: '严重意见' }),
        ],
      }),
    })
    const highPos = md.indexOf('src/high.ts')
    const lowPos = md.indexOf('src/low.ts')
    expect(highPos).toBeGreaterThan(-1)
    expect(lowPos).toBeGreaterThan(highPos)
    expect(md).toContain('[严重·缺陷]')
    expect(md).toContain('[轻微·缺陷]')
    expect(md).toContain('严重 1 · 一般 0 · 轻微 1')
  })

  it('suggestion 存在时输出建议行，换行压缩为空格', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({
        issues: [issue({ comment: '多行\n问题', suggestion: '第一行\n第二行' })],
      }),
    })
    expect(md).toContain('多行 问题')
    expect(md).toContain('- 建议：第一行 第二行')
  })

  it('建议行缩进随序号宽度动态对齐（评审 #49：两位数序号下 3 空格会脱离父项嵌套）', () => {
    // 11 条跨 11 个文件的意见 → 最后一条序号为两位数「11.」
    const issues = Array.from({ length: 11 }, (_, i) =>
      issue({ file: `src/f${i}.ts`, comment: `问题${i}`, suggestion: `建议${i}` }),
    )
    const md = buildReviewComment({ repo: 'r/r', number: 1, result: result({ issues }) })
    // 个位数序号（1.-9.）内容列在第 3 格 → 建议 3 空格缩进
    expect(md).toContain('\n   - 建议：建议0')
    // 两位数序号（10./11.）内容列在第 4 格 → 建议 4 空格缩进，仍为父项嵌套子列表
    expect(md).toContain('\n    - 建议：建议9')
    expect(md).toContain('\n    - 建议：建议10')
  })

  it('无意见时输出「未发现可定位的待处理问题」', () => {
    const md = buildReviewComment({ repo: 'r/r', number: 1, result: result({}) })
    expect(md).toContain('未发现可定位的待处理问题')
  })

  it('无意见提示行与分隔线之间有空行（评审 #62）：不补空行会被 CommonMark 解析为 setext 二级标题', () => {
    const md = buildReviewComment({ repo: 'r/r', number: 1, result: result({ issues: [] }) })
    expect(md).toContain('未发现可定位的待处理问题。\n\n---')
  })

  it('无意见且有 unlocatable 时：提示行与「另有 N 条」提示不并段（评审 #62 懒延续）', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({ issues: [issue({ comment: '脏坐标', line: 999, locationStatus: 'unlocatable' })] }),
    })
    expect(md).toContain('未发现可定位的待处理问题。\n\n另有 1 条')
  })

  it('超长单行意见被钳制（评审 #61）：comment/suggestion 限长 300，后续意见不被整段截掉', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({
        issues: [
          issue({ comment: '超长问题'.repeat(200), suggestion: '超长建议'.repeat(200), file: 'src/big.ts' }),
          issue({ comment: '第二条意见', file: 'src/next.ts' }),
        ],
      }),
    })
    // comment/suggestion 各被钳到 300 字 + 省略号（4 字词 ×75 + …）
    expect(md).toContain('超长问题'.repeat(75) + '…')
    expect(md).not.toContain('超长问题'.repeat(76))
    expect(md).toContain('超长建议'.repeat(75) + '…')
    expect(md).not.toContain('超长建议'.repeat(76))
    // 后续意见明细正常存活（不被超长行挤进截断区），且全文未触发截断告警
    expect(md).toContain('第二条意见')
    expect(md).not.toContain('本评论已截断')
  })

  it('超限截断：超过 60000 字符截断并附截断说明（标记仍保留在头部）', () => {
    const issues = Array.from({ length: 400 }, (_, i) =>
      issue({ comment: `意见${i}`.padEnd(200, '长'), file: `src/f${i}.ts` }),
    )
    const md = buildReviewComment({ repo: 'r/r', number: 1, result: result({ issues }) })
    expect(md.length).toBeLessThanOrEqual(60120)
    expect(md).toContain('mergehub-review:v1')
    expect(md).toContain('本评论已截断')
  })

  it('超长单行摘要被钳制（评审 #58）：摘要限长 120 字，意见明细不受挤占', () => {
    const md = buildReviewComment({
      repo: 'r/r',
      number: 1,
      result: result({
        // 单行超长摘要（无换行），组装前必须钳制——否则截断点回退（lastIndexOf('\n')）
        // 会拉到头部区域，意见明细几乎全部被截掉
        summary: '超长摘要'.repeat(500),
        issues: [issue({ comment: '第一条真实意见', suggestion: '修一下' })],
      }),
    })
    // 摘要被钳到 120 字 + 省略号（「超长摘要」4 字 ×30 + …）
    expect(md).toContain('超长摘要'.repeat(30) + '…')
    expect(md).not.toContain('超长摘要'.repeat(31))
    // 意见明细正常存活
    expect(md).toContain('第一条真实意见')
    expect(md).toContain('- 建议：修一下')
  })

  it('截断点落在行边界（评审 #28：不切断列表项/加粗语法）', () => {
    const issues = Array.from({ length: 400 }, (_, i) =>
      issue({ comment: `意见${i}`.padEnd(200, '长'), file: `src/f${i}.ts` }),
    )
    const md = buildReviewComment({ repo: 'r/r', number: 1, result: result({ issues }) })
    // 截断说明以「\n\n> ⚠️」独立成段；其之前的正文必须以换行符结尾——
    // 即切口在某个完整行之后，不会切在列表项/加粗/标题的中间
    const sepPos = md.lastIndexOf('\n\n> ')
    expect(sepPos).toBeGreaterThan(-1)
    expect(md.slice(0, sepPos)).toMatch(/\n$/)
    expect(md).toContain('本评论已截断')
  })
})

describe('findReviewComment 幂等定位', () => {
  const marker = reviewCommentMarker('acme/app', 12)

  it('命中标记的评论返回其 id（标记恒在首行，buildReviewComment 契约）', () => {
    const id = findReviewComment(
      [
        { id: 1, body: '普通讨论' },
        { id: 2, body: `${marker}\n> 🤖 **MergeHub AI 评审**\n\n正文` },
      ],
      'acme/app',
      12,
    )
    expect(id).toBe(2)
  })

  it('无命中返回 null（首次回写走发布）', () => {
    expect(findReviewComment([{ id: 1, body: '普通讨论' }], 'acme/app', 12)).toBeNull()
    expect(findReviewComment([], 'acme/app', 12)).toBeNull()
  })

  it('仓库或 PR 号不同不误认（评论被搬到其他 PR 场景）', () => {
    expect(
      findReviewComment([{ id: 1, body: marker }], 'acme/other', 12),
    ).toBeNull()
    expect(findReviewComment([{ id: 1, body: marker }], 'acme/app', 13)).toBeNull()
  })

  it('PR 号前缀包含不误定位（评审 #29：查 #12 不得命中 #123 的标记）', () => {
    const id = findReviewComment(
      [{ id: 123, body: reviewCommentMarker('acme/app', 123) }],
      'acme/app',
      12,
    )
    expect(id).toBeNull()
    // 反向：完整标记含结尾 -->，查 #123 能正常命中自己
    expect(
      findReviewComment([{ id: 123, body: reviewCommentMarker('acme/app', 123) }], 'acme/app', 123),
    ).toBe(123)
  })

  it('引用回复不误定位（评审 #33：quote-reply 复制原文，标记随引用行进入正文）', () => {
    // 模拟 GitHub 引用回复：整条汇总评论被复制为 > 引用行 + 用户自己的话
    const quoted = `> ${reviewCommentMarker('acme/app', 12)}\n> 🤖 **MergeHub AI 评审**\n\n这条意见第 2 条是误报，我已修复。`
    // 引用回复是最新评论（排在最后），倒序检索也不得命中
    const id = findReviewComment(
      [
        { id: 1, body: `${reviewCommentMarker('acme/app', 12)}\n真汇总评论` },
        { id: 2, body: quoted },
      ],
      'acme/app',
      12,
    )
    expect(id).toBe(1)
  })

  it('正文中间出现完整标记（非首行）不命中', () => {
    const id = findReviewComment(
      [{ id: 1, body: `别人先说了句话\n\n${reviewCommentMarker('acme/app', 12)}\n正文` }],
      'acme/app',
      12,
    )
    expect(id).toBeNull()
  })

  it('CRLF 行尾兼容（评审 #46）：平台存取链路引入 \\r\\n 时首行比对不受尾部 \\r 干扰', () => {
    const crlfBody = `${reviewCommentMarker('acme/app', 12)}\r\n> 🤖 MergeHub AI 评审\r\n\r\n正文`
    const id = findReviewComment([{ id: 1, body: crlfBody }], 'acme/app', 12)
    expect(id).toBe(1)
  })

  it('多个历史汇总评论取最后一个（最新发布胜出）', () => {
    const id = findReviewComment(
      [
        { id: 1, body: marker },
        { id: 2, body: marker },
      ],
      'acme/app',
      12,
    )
    expect(id).toBe(2)
  })
})
