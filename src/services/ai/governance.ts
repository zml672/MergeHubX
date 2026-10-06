/** 治理提炼：把勾选的治理记录（豁免/遵守）连同用户评论交给 AI 归纳为一条规则（title + content） */

import { chatCompletionStream, isReviewCancelled } from './client'
import type { ChatMessage, ReviewCancelHandle, StreamResult } from './client'
import { logAiAnswer, logAiError, logAiRequest, shortHash } from '../aiDebugLog'
import type { AiModelConfig, IssueDisposition } from '../../types/ai'

/** 治理提炼的单条输入：来自勾选的治理记录；note 为用户针对该条写的评论，供 AI 参考团队判断意图 */
export interface GovernanceSummaryInput {
  file: string
  line: number
  type: string
  comment: string
  note?: string
}

/** 治理提炼的流式进度：已收字数 + 尽力从半成品 JSON 中提取出的规则正文片段 */
export interface GovernanceSummaryProgress {
  answerChars: number
  reasoningChars: number
  contentText: string
}

/** 从流式半成品的 JSON 原文中尽力提取已生成的 content 片段并反转义，供实时预览；无法提取时返回空串 */
function extractStreamingContent(raw: string): string {
  const match = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
  if (!match) return ''
  let text = match[1]
  for (let cut = 0; cut < 6; cut++) {
    try {
      return JSON.parse(`"${text}"`) as string
    } catch {
      text = text.slice(0, -1)
    }
  }
  return ''
}

/** 严格 JSON 解析失败时的兜底：正则直接提取字段字符串值并反转义，容忍模型在值中输出裸换行或在 JSON 后附带说明文字 */
function extractJsonStringField(raw: string, field: 'title' | 'content'): string {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)
  if (!match) return ''
  const text = match[1].replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  try {
    return JSON.parse(`"${text}"`) as string
  } catch {
    return ''
  }
}

/** 构建治理提炼消息（纯函数）：system 按处置方式区分豁免/遵守语义并给出 content 格式约束，user 附仓库与待归纳记录 */
function buildSummarizeMessages(
  disposition: IssueDisposition,
  repo: string,
  records: GovernanceSummaryInput[],
): ChatMessage[] {
  const intent =
    disposition === 'exempt'
      ? [
          '你是代码评审规范助手。用户会提供一组团队已确认「可接受/不予报告」的代码问题记录，',
          '部分记录附有「我的评论」，表达团队的判断意图，请一并参考。',
          '请把它们归纳成一条可复用的豁免规则，供日后 AI 评审时判断同类问题不再报告。',
        ]
      : [
          '你是代码评审规范助手。用户会提供一组团队确认需要整改遵守的代码问题记录，',
          '部分记录附有「我的评论」，表达团队的判断意图，请一并参考。',
          '请把它们归纳成一条团队编码规范，供日后 AI 评审时逐条对照 diff 核验。',
        ]
  return [
    {
      role: 'system',
      content: [
        ...intent,
        'content 必须遵循以下格式：',
        '1. 总分总结构：开头总述（一两句概括主题与范围），中间分分类展开，结尾用一句总结收束（说明整体边界或适用前提）；',
        '2. 分类需合并同类项：把相近问题归为一类，分类标题单独一行，用「一、」「二、」「三、」中文序号；',
        '3. 每个分类下的具体条目另起一行，行首用两个空格缩进，以「1.」「2.」「3.」编号；',
        '4. 精简提炼：不要罗列原始记录，不要保留具体文件名与行号（规则需能匹配未来的新代码），每行不超过 100 字，避免长句与拗口表述；',
        '5. title 不超过 8 个汉字，概括规则针对的对象类别。',
        '只输出一个 JSON 对象：{"title":"规则名","content":"规则内容"}，content 中的换行用 \\n 表示。',
        '不要代码块标记，不要解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `仓库：${repo}\n待归纳的记录：\n${records
        .map((r, i) => {
          const head = `${i + 1}. [${r.type}] ${r.file}:${r.line}：${r.comment}`
          const note = r.note?.trim()
          return note ? `${head}\n   我的评论：${note}` : head
        })
        .join('\n')}`,
    },
  ]
}

/** 解析提炼输出（纯函数）：剥代码围栏后 JSON 解析，失败回退逐字段提取，再校验 title/content 非空；不合法时抛错由调用方落盘（导出供单元测试） */
export function parseSummaryOutput(raw: string): { title: string; content: string } {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  let parsed: { title?: unknown; content?: unknown }
  try {
    parsed = JSON.parse(text) as { title?: unknown; content?: unknown }
  } catch {
    const fallbackTitle = extractJsonStringField(text, 'title')
    const fallbackContent = extractJsonStringField(text, 'content')
    if (!fallbackTitle || !fallbackContent) {
      throw new Error('AI 未返回有效的 JSON 提炼结果，请重试')
    }
    parsed = { title: fallbackTitle, content: fallbackContent }
  }
  const title =
    typeof parsed.title === 'string' ? parsed.title.trim().replace(/^["'「]+|["'」]+$/g, '') : ''
  const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
  if (!title || !content) {
    throw new Error('AI 提炼结果缺少标题或内容，请重试')
  }
  return { title, content }
}

/** 把勾选的治理记录连同用户评论交给 AI 归纳为一条规则（title + content），双轨按 disposition 区分豁免/遵守语义；流式输出，onProgress 回调已收字数与实时正文片段 */
export async function summarizeGovernanceRules(
  config: AiModelConfig,
  disposition: IssueDisposition,
  repo: string,
  records: GovernanceSummaryInput[],
  onProgress?: (progress: GovernanceSummaryProgress) => void,
  cancel?: ReviewCancelHandle,
): Promise<{ title: string; content: string }> {
  if (records.length === 0) throw new Error('没有可提炼的记录')
  // 提炼可能横跨多个仓库（repo 为多仓库「、」连接的展示串，本地与远程可混合），日志目录按完整串派生：
  // governance_{可读段}_{8 位哈希}，与 remoteLogDir/localLogDir 同策略——可读段仅辅助人眼识别，
  // 哈希输入为完整标识，单/多仓库、同名仓库、等长差异均由哈希区分，各仓库提炼日志物理隔离
  const logDir = `governance_${repo.split(/[\\/、]/).filter(Boolean).join('-')}_${shortHash(repo)}`
  const messages = buildSummarizeMessages(disposition, repo, records)
  logAiRequest(`治理提炼（${repo}）`, config.model, logDir, messages)
  let stream: StreamResult
  try {
    stream = await chatCompletionStream(
      config,
      messages,
      (p) => {
        onProgress?.({
          answerChars: p.answerChars,
          reasoningChars: p.reasoningChars,
          contentText: extractStreamingContent(p.answerText),
        })
      },
      cancel,
    )
  } catch (err) {
    // 用户主动取消不落盘错误日志，与 AI 评审等其余场景的取消处理保持一致
    if (isReviewCancelled(err)) throw err
    logAiError(logDir, `治理提炼（${repo}）`, err, config.model)
    throw err
  }
  logAiAnswer(logDir, `治理提炼（${repo}）`, stream.content)
  let summary: { title: string; content: string }
  try {
    summary = parseSummaryOutput(stream.content)
  } catch (err) {
    logAiError(logDir, `治理提炼（${repo}）`, err, config.model)
    throw err
  }
  return summary
}
