/** AI 生成 Git 提交说明：Conventional Commits 规范的 system 约束与受预算约束的 patch 摘录 */

import { chatCompletion } from './client'
import type { ChatMessage } from './client'
import type { AiModelConfig } from '../../types/ai'
import type { DiffFile } from '../../types/platform'
import { localLogDir, logAiAnswer, logAiError, logAiRequest } from '../aiDebugLog'

/** 把变更文件列表整理为提交说明生成的输入：文件清单 + 受预算约束的 patch 摘录（导出供单元测试） */
export function buildCommitContext(files: DiffFile[]): string {
  const statusLabels: Record<DiffFile['status'], string> = {
    added: '新增',
    modified: '修改',
    removed: '删除',
    renamed: '重命名',
  }
  const FILE_PATCH_BUDGET = 1200
  const TOTAL_PATCH_BUDGET = 6000
  let budget = TOTAL_PATCH_BUDGET
  const lines: string[] = []
  for (const f of files) {
    lines.push(`- ${f.path}（${statusLabels[f.status]}，+${f.additions}/-${f.deletions}）`)
    if (budget <= 0 || !f.patch) continue
    let patch = f.patch.slice(0, Math.min(FILE_PATCH_BUDGET, budget))
    // 摘录按行边界裁尾：硬切在行中间会留下残缺行，影响模型对 diff 的理解；
    // 前缀内无换行可对齐时（单行 patch）退化为硬切
    const nl = patch.lastIndexOf('\n')
    if (nl > 0) patch = patch.slice(0, nl + 1)
    lines.push(patch)
    budget -= patch.length
  }
  return lines.join('\n')
}

/** Conventional Commits 首行的 type 头（type 关键字 + 可选 scope + 可选 !） */
const TYPE_HEAD = String.raw`(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?`
const CONVENTIONAL_FIRST_LINE = new RegExp(`^${TYPE_HEAD}: \\S`)
/** 「type：描述」「type:描述」「type : 描述」等变体归一为「type: 描述」 */
const COLON_NORMALIZE = new RegExp(`^(${TYPE_HEAD})[ \t]*(?:：|:)[ \t]*`)

/** 校验首行是否符合 Conventional Commits「type: 描述」格式（导出供单元测试） */
export function isConventionalCommitFirstLine(text: string): boolean {
  const firstLine = text.trim().split('\n')[0] ?? ''
  return CONVENTIONAL_FIRST_LINE.test(firstLine)
}

/** 提交说明输出的确定性规范化（导出供单元测试）：剥包裹整体的代码围栏、
 *  首行中文冒号/缺空格归一、兜底首行与正文间的空行。
 *  缺 type 等无法确定性修复的问题不做臆测改写，交给调用方重试 */
export function normalizeCommitMessageOutput(content: string): string {
  let text = content.trim()
  // 模型偶发无视「不要代码块标记」约束：剥除包裹整体输出的围栏
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  const lines = text.split('\n')
  lines[0] = lines[0].replace(COLON_NORMALIZE, '$1: ')
  // 兜底保证 body-leading-blank：模型偶发漏掉首行与正文之间的空行时自动补上
  if (lines.length > 1 && lines[1].trim() !== '') {
    lines.splice(1, 0, '')
  }
  return lines.join('\n')
}

/** 依据勾选的变更文件 diff 生成提交说明：首行为 Conventional Commits 的「type: 描述」格式，type 按变更目的判定（缺陷修复为 fix、新增能力为 feat、行为不变的结构调整为 refactor），正文与首行之间必须空行分隔，描述用中文 */
export async function generateCommitMessage(
  config: AiModelConfig,
  repo: string,
  files: DiffFile[],
): Promise<string> {
  if (files.length === 0) throw new Error('没有可生成说明的变更文件')
  const logDir = localLogDir(repo)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是 Git 提交信息助手，严格遵循 Conventional Commits 规范。',
        '用户会提供一组工作区变更文件的清单和 diff，请为这次提交生成符合规范的提交说明。',
        '要求：第一行必须为「type: 描述」格式，type 是从 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert 中选出的英文小写关键字，后接英文冒号加一个空格；',
        'type 按变更目的判定：修复行为不符预期或缺陷选 fix；给使用者新增能力或行为选 feat；性能提升选 perf；文档变更选 docs；测试变更选 test；构建或依赖选 build；流水线选 ci；无法归入以上且不影响使用者的日常维护选 chore；',
        'refactor 仅用于使用者可感知的行为完全不变、只调整代码内部结构的变更——为修复缺陷而做的结构调整（如状态迁移、组件拆分）属于 fix 而非 refactor；',
        '多种性质混合时以本次变更的主要意图为准；描述用不超过 50 字的中文祈使句写明解决或新增了什么，避免「优化功能」「修复问题」这类空洞概括，首行结尾不加句号等标点；',
        '如需附加要点，必须先输出一个空行再开始要点列表（要点列表与首行之间必须有空行），要点最多 3 行、每行以 - 开头，要点写关键的行为变化；',
        '不要罗列文件名；直接输出说明正文，不要开场白、解释或代码块标记；除 type 关键字外均用中文。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `仓库：${repo}\n变更文件：\n${buildCommitContext(files)}`,
    },
  ]
  logAiRequest('提交说明生成', config.model, logDir, messages)
  let raw: string
  try {
    raw = await chatCompletion(config, messages)
  } catch (err) {
    logAiError(logDir, '提交说明生成', err, config.model)
    throw err
  }
  logAiAnswer(logDir, '提交说明生成', raw)
  let output = normalizeCommitMessageOutput(raw)
  if (!isConventionalCommitFirstLine(output)) {
    // 一次性格式纠正重试：缺 type 等问题无法确定性修复，附纠正提示让模型重出。
    // 提交说明是便利功能，纠正调用失败或纠正后仍不合规范都不阻断——回退首次输出，
    // 结果最终填入可编辑输入框，由用户把关
    try {
      const corrected = await chatCompletion(config, [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content:
            '你的上一条输出不符合 Conventional Commits 首行格式。请重新输出完整提交说明：第一行必须为「type: 描述」格式——type 是 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert 之一的英文小写关键字，后接英文冒号加一个空格；不要代码块标记，不要解释。',
        },
      ])
      const normalized = normalizeCommitMessageOutput(corrected)
      if (isConventionalCommitFirstLine(normalized)) output = normalized
    } catch (err) {
      logAiError(logDir, '提交说明生成（格式纠正重试）', err, config.model)
    }
  }
  return output
}
