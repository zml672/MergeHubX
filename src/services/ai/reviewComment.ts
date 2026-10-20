import { AI_ISSUE_TYPE_META, AI_RISK_META, AI_SEVERITY_META } from '../../types/ai'
import type { AiIssue, AiReviewResult } from '../../types/ai'
import {
  compareGroupRisk,
  pendingIssueStatsOf,
  pendingNoteOf,
  SEVERITY_WEIGHT,
} from '../../composables/useAiReviewFlow'
import { mdNestedIndent } from '../platforms/utils'

/** MergeHub 汇总评论的幂等标记：明文署名 + HTML 注释锚点（三个平台均不渲染 HTML 注释，
 *  但 API 原文可检索）。锚点内联版本号与仓库/PR 号，结尾 --> 是标记完整性的一部分：
 *  PR 号前缀包含（#12 vs #123）不会误认，评论被人工搬到其他 PR 时也不会。
 *  契约：buildReviewComment 恒将标记置于正文首行，findReviewComment 仅比对首行——
 *  引用/转发场景标记随原文明文进入引用块（行首带 >），不在首行，天然排除 */
export function reviewCommentMarker(repo: string, number: number): string {
  return `<!-- mergehub-review:v1 ${repo}#${number} -->`
}

/** 意见行号可定位才写入评论（偏置原则：unlocatable 的坐标不可信，公开到评论里误导读者，
 *  与面板「降级展示、绝不删除」的口径不同——评论是对外正式意见，宁缺勿错） */
function isLocatable(issue: AiIssue): boolean {
  return issue.locationStatus !== 'unlocatable'
}

/** 按文件分组问题并组间排序：先比组内最高严重度，同档比风险总分——
 *  排序口径复用导出 Markdown 的 compareGroupRisk（评审 #27：注释声称复用就必须真复用，
 *  内联重写终将漂移）；文件分组结构无法直接复用 useReviewExport 的局部实现，仅排序单源 */
function groupByFile(
  issues: AiIssue[],
): { file: string; list: AiIssue[]; maxWeight: number; score: number }[] {
  const groups = new Map<string, AiIssue[]>()
  for (const issue of issues) {
    const group = groups.get(issue.file)
    if (group) group.push(issue)
    else groups.set(issue.file, [issue])
  }
  return [...groups.entries()]
    .map(([file, list]) => ({
      file,
      list,
      maxWeight: Math.max(...list.map((issue) => SEVERITY_WEIGHT[issue.severity])),
      score: list.reduce((sum, issue) => sum + SEVERITY_WEIGHT[issue.severity], 0),
    }))
    .sort((a, b) => compareGroupRisk(a, b))
}

/** 意见单行上限（评审 #61）：comment/suggestion 仅压平换行不钳长度时，单条超长意见
 *  自身就会吃满 60000 字预算，行边界截断（#28）会把该行及其后内容整段截掉，头部
 *  「共 N 条」统计仍按全量展示、与实际可见条数脱节。钳制量级同导出侧 mdCell
 *  （600 字/格）与摘要钳制（#58 120 字）之间，单条足够表达且叠加预算可控 */
const ISSUE_LINE_MAX_CHARS = 300

/** 压平换行 + 单行钳制（评审 #61）：与摘要钳制（#58）同一套防挤占逻辑 */
function flattenCell(text: string): string {
  const flat = text.replace(/\s*\n+\s*/g, ' ')
  return flat.length > ISSUE_LINE_MAX_CHARS
    ? `${flat.slice(0, ISSUE_LINE_MAX_CHARS)}…`
    : flat
}

/** 意见条目行：与导出清单同款「[严重度·类型] file:line 问题 + 建议」结构，但压成两条列表项（评论是流式阅读场景，不用表格）。
 *  建议行缩进按序号宽度动态生成（评审 #49）：`10.` 起的内容列在第 4 格，固定 3 空格的
 *  「- 建议」行会脱离父项被 CommonMark 解析为顶层列表或懒延续行，嵌套渲染失效；
 *  `String(index+1).length + 2` 使任意序号宽度下建议行标记列都与父项内容列对齐 */
function issueLines(issue: AiIssue, index: number): string[] {
  const lines = [
    `${index + 1}. **[${AI_SEVERITY_META[issue.severity].label}·${AI_ISSUE_TYPE_META[issue.type].label}]** \`${issue.file}:${issue.line}\` ${flattenCell(issue.comment)}`,
  ]
  if (issue.suggestion) {
    const indent = mdNestedIndent(index + 1)
    lines.push(`${indent}- 建议：${flattenCell(issue.suggestion)}`)
  }
  return lines
}

/** 摘要单行上限（评审 #58）：模型偶发输出超长 summary 时，截断点回退（lastIndexOf('\n')）
 *  会一路退回头部区域、意见明细几乎全部被截掉只剩头部与告警。在组装前钳制单行长度
 *  （量级同 prompts.ts 提炼约束的 100 字），保证截断点至少落在意见区 */
const SUMMARY_MAX_CHARS = 120

export interface BuildReviewCommentInput {
  /** 目标仓库（owner/repo 或 GitLab 全路径），用于标记冗余校验 */
  repo: string
  number: number
  result: AiReviewResult
  /** 本轮新增待处理统计（与面板/导出同口径）；缺省时由构建器现场计算（回调恒 false，仅测试兜底） */
  pending?: { pending: number; fixed: number; exempt: number }
}

/** 组装评审汇总评论 Markdown（纯函数，R2）：
 *  头部 = 幂等标记 + 署名 + 风险等级 + 本轮新增待处理（豁免/已修复附注经 pendingNoteOf 零片段不拼）；
 *  正文 = 摘要 + 按文件分组意见（unlocatable 不写入）；尾部 = 免责与跳转治理指引。
 *  评论字符上限 60000（GitHub 65536 / GitLab 1000000 / Gitee 无公开硬限，取最紧平台留余量），
 *  超限截断意见明细并附截断说明，头部统计永远完整 */
export function buildReviewComment(input: BuildReviewCommentInput): string {
  const { result } = input
  const pending =
    input.pending ??
    pendingIssueStatsOf(result.issues, () => false, () => undefined)

  const note = pendingNoteOf(pending)
  const pendingLine =
    `**本轮新增待处理 ${pending.pending} 条**` + (note ? `（${note}）` : '')

  const locatable = result.issues.filter(isLocatable)
  const hiddenCount = result.issues.length - locatable.length

  const head = [
    reviewCommentMarker(input.repo, input.number),
    `> 🤖 **MergeHub AI 评审** · ${AI_RISK_META[result.riskLevel].label} · ${pendingLine}`,
    '',
    '',
  ]

  const body: string[] = []
  if (result.summary) {
    // 摘要钳制单行长度（评审 #58）：防超长单行把截断点回退拉到头部、意见明细被整段截掉
    const summary = result.summary.replace(/\s*\n+\s*/g, ' ')
    body.push(summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary, '')
  }
  if (locatable.length === 0) {
    // 尾随空行必须有（评审 #62）：该行与尾部 --- 之间无空行时会被 CommonMark 解析为
    // setext 二级标题（段落行紧跟 --- 是 setext 语法）；hiddenCount>0 时也会与
    // 「另有 N 条…」提示懒延续并成一段
    body.push('未发现可定位的待处理问题。', '')
  } else {
    body.push(
      `共 ${locatable.length} 条意见（严重 ${locatable.filter((i) => i.severity === 'high').length} · 一般 ${locatable.filter((i) => i.severity === 'medium').length} · 轻微 ${locatable.filter((i) => i.severity === 'low').length}）`,
      '',
    )
    let index = 0
    for (const { file, list } of groupByFile(locatable)) {
      body.push(`### ${file}`, '')
      for (const issue of list) {
        body.push(...issueLines(issue, index))
        index += 1
      }
      body.push('')
    }
  }
  if (hiddenCount > 0) {
    body.push(`另有 ${hiddenCount} 条意见无法在变更文件中定位坐标，未列入本评论（可在 MergeHub 报告中查看）。`, '')
  }
  body.push('---', '*由 MergeHub 自动生成 · 意见处置（豁免/遵守）请在应用内治理工作台进行，下次评审将自动收敛重复意见。*')

  // head 尾行留一个空行元素，join 后与 body 首行之间是「空行」——CommonMark 懒延续
  // （评审 #35）会把紧贴引用行的普通段落并进「> 🤖」引用块渲染，统计行必须独立成段
  let markdown = head.join('\n') + body.join('\n')
  const MAX_COMMENT_CHARS = 60000
  if (markdown.length > MAX_COMMENT_CHARS) {
    // 截断点回退到最后一个换行符（评审 #28：按字符硬切会切在列表项/加粗/代码围栏中间，
    // 产生破碎渲染）；行边界截断保证切口落在完整行之后
    const cutAt = markdown.lastIndexOf('\n', MAX_COMMENT_CHARS)
    markdown = `${markdown.slice(0, cutAt > 0 ? cutAt : MAX_COMMENT_CHARS)}\n\n> ⚠️ 意见过多，本评论已截断，完整报告请查看 MergeHub。`
  }
  return markdown
}

/** 从既有评论中定位 MergeHub 汇总评论 id（幂等更新不追加的关键）：
 *  仅比对正文首行是否为完整标记（评审 #29：整体匹配防 PR 号前缀包含；
 *  评审 #33：全文 includes 会命中引用回复——GitHub quote-reply 复制原文时标记随
 *  引用行（行首带 >）进入回复，且回复通常最新、倒序检索必先命中，下次回写会覆盖
 *  用户回复；buildReviewComment 契约保证真汇总评论的标记恒在首行，引用行不在首行，
 *  首行比对天然排除）。首行切分兼容 CRLF（评审 #46）：split(/\r?\n/, 1)——
 *  平台存取链路若引入 \r\n 行尾，split('\n') 取得的首行会带尾部 \r、严格相等必失败，
 *  幂等更新退化为重复发布。找不到返回 null（首次回写走发布）；多个历史汇总评论时取
 *  最后一个（最新发布的胜出） */
export function findReviewComment(
  comments: { id: number; body: string }[],
  repo: string,
  number: number,
): number | null {
  const marker = reviewCommentMarker(repo, number)
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (comments[i].body.split(/\r?\n/, 1)[0] === marker) return comments[i].id
  }
  return null
}
