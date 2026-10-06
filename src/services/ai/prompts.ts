/** 评审提示词的各段构建器（纯函数）：系统契约、评审维度段头、团队规范/豁免段头。
 *  注意：本文件的文案与下游解析器（parseReviewContent 白名单校验、issueFingerprint 指纹匹配）
 *  是同一协议的两半，修改「契约区」文本前先阅读 docs/优化清单及后期路线说明.md 的 P2-5 锚点表 */

import type { GovernanceRecord, ReviewRule } from '../../types/ai'

function buildSystemPrompt(batchMode: boolean, hasPrevious = false): string {
  const base = [
    '你是一位资深代码评审专家，负责审查合并请求的代码变更。',
    '从缺陷、安全、性能、可维护性与风格等维度分析 diff，并遵守用户提供的团队规范。',
    '输出要求：只输出一个 JSON 对象，不要使用 markdown 代码块，不要输出任何解释性文字。',
    'JSON 结构：',
    '{"summary":"核心总评（中文，不超过 3 句）：只概括本次变更的性质与最重要的风险方向，直接指出最需要关注的问题；不要罗列文件数量、各等级问题数等统计信息（系统会精确统计），不要逐条复述问题","riskLevel":"low|medium|high","issues":[{"file":"文件路径","line":12,"severity":"low|medium|high","type":"bug|security|performance|style|convention","comment":"问题描述（中文）","suggestion":"具体修复建议（中文，一行，可给出关键代码方向）"}]}',
    '约定：line 为问题所在行在新文件中的真实行号，必须依据 diff 的 hunk 头（@@ -旧起,行 +新起,行 @@）与问题内容在 hunk 内的位置换算得出（新行号 = hunk 头新起始行 + 问题所在行到 hunk 首行之间的新增行数），禁止臆测或照抄示例值；仅当问题确实无法对应到任何具体行（如纯文件级结论）时才填 0；没有问题时 issues 为空数组；',
    'suggestion 给出可直接执行的修复思路，若确实无法给出则省略该字段；',
    'type 为 convention 表示违反团队规范，comment 必须以【规则名】开头引用对应规则。',
  ]
  if (hasPrevious) {
    base.push(
      '用户消息中附有上次评审发现的问题清单，请结合当前 diff 逐条核对这些问题的修复情况，并在 JSON 中增加 "previousChecks" 数组逐条输出核对结果：',
      '"previousChecks":[{"file":"原样抄写清单中的文件路径","line":12,"severity":"low|medium|high","type":"bug|security|performance|style|convention","comment":"原样抄写清单中的问题描述","status":"fixed|partial|not_fixed","note":"复核结论（中文一句话，说明依据）"}]',
      'status 判定标准：fixed 表示该问题在当前 diff 中已不存在；partial 表示有改进但未彻底解决；not_fixed 表示问题仍然存在。',
      'previousChecks 必须与问题清单一一对应、条数一致；核对结论为 not_fixed 或 partial 的问题，在 issues 中也要照常列出。',
    )
  }
  if (batchMode) {
    base.push(
      '本次评审采用分批方式：diff 被拆分为多个批次逐一分析，你只会看到其中一个批次的 diff 与完整的全局变更清单。',
      '请仅针对当前批次 diff 中出现的内容输出 issues；总评只概括本批内容，不要臆测清单中未给出 diff 的文件。',
    )
  }
  return base.join('\n')
}

function buildRulesSection(rules: ReviewRule[]): string {
  const standardRules = rules.filter((r) => r.kind !== 'exemption')
  if (standardRules.length === 0) return ''
  const lines = standardRules.map((r, i) => `${i + 1}. 【${r.name}】\n${r.content}`)
  return [
    '## 团队规范核验（必须逐条核验）',
    '以下为团队自定义规范，请逐条对照 diff 检查。发现违反时输出 type 为 convention 的问题，',
    '并在 comment 开头以【规则名】引用对应规范；未发现违反时不要输出该规范相关内容。',
    '',
    ...lines,
  ].join('\n')
}

/** 构建豁免规则段：沉淀自豁免记录的豁免型规范，要求模型不再报告相同或实质相似的问题 */
function buildExemptionRulesSection(rules: ReviewRule[]): string {
  const exemptionRules = rules.filter((r) => r.kind === 'exemption')
  if (exemptionRules.length === 0) return ''
  const lines = exemptionRules.map((r, i) => `${i + 1}. 【${r.name}】\n${r.content}`)
  return [
    '## 团队豁免规则（不要再次报告）',
    '以下为团队沉淀的豁免规则（确认为可接受或历史误报）。请勿在 issues 中输出与它们相同或实质相似的问题；',
    '也不要因规避它们而遗漏真正的新问题：若同一位置出现明显不同的新缺陷，仍应正常报告。',
    '',
    ...lines,
  ].join('\n')
}

/** 提示词单条文本的净化：压缩换行与空白为单空格、去首尾——模型输出的文本（受不可信 diff
 *  影响）中的换行可伪造新列表项或新段落，向提示词注入结构性指令。
 *  使用边界：净化会改写文本，凡文本参与指纹匹配或回写匹配的场景不得使用
 *  （如 buildBatchPrompt 的上轮问题列表行是指纹匹配数据源，必须保持原样）；
 *  豁免段与复核清单等纯提示词展示场景适用 */
export function sanitizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 豁免段单条 comment 的长度上限：防提示词膨胀（提炼约束的「每行不超 100 字」同为量级参考） */
const EXEMPT_COMMENT_MAX_CHARS = 120

/** 构建历史误报豁免段：列出被团队标记豁免的问题，要求模型不再报告相同或实质相似的问题 */
function buildExemptRecordsSection(exempt: GovernanceRecord[]): string {
  if (exempt.length === 0) return ''
  const lines = exempt.map((r, i) => {
    const comment = sanitizeInline(r.comment)
    const truncated =
      comment.length > EXEMPT_COMMENT_MAX_CHARS
        ? `${comment.slice(0, EXEMPT_COMMENT_MAX_CHARS)}…`
        : comment
    const file = sanitizeInline(r.file)
    return `${i + 1}. [${r.type}] ${file}${r.line > 0 ? `（第 ${r.line} 行附近）` : ''}：${truncated}`
  })
  return [
    '## 历史误报豁免（不要再次报告）',
    '以下问题已被团队标记豁免（确认为可接受或历史误报）。请勿在 issues 中输出与它们相同或实质相似的问题；',
    '也不要因规避它们而遗漏真正的新问题：若同一位置出现明显不同的新缺陷，仍应正常报告。',
    '',
    ...lines,
  ].join('\n')
}

export { buildSystemPrompt, buildRulesSection, buildExemptionRulesSection, buildExemptRecordsSection }
