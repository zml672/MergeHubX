import { message } from 'ant-design-vue'
import dayjs from 'dayjs'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { AI_ISSUE_TYPE_META, AI_RISK_META, AI_SEVERITY_META } from '../types/ai'
import type { AiIssue, AiIssueSeverity } from '../types/ai'
import {
  PREV_STATUS_META,
  SEVERITY_WEIGHT,
  compareGroupRisk,
  mdCell,
} from './useAiReviewFlow'
import type { AiReviewFlow } from './useAiReviewFlow'

/** 导出评审报告为 Markdown 文件：分析结果 + 修复对比 + 按文件分组的问题清单（系统另存为对话框）。
 *  标题与文件名由各视图通过 flow 注入（本地=工作区变更 / 远程=PR），组装逻辑共用 */
export function useReviewExport(flow: AiReviewFlow) {
  async function exportMarkdown() {
    const result = flow.aiResult.value
    if (!result) return
    const reportTitle = flow.exportTitle.value
    const stats = flow.summaryStats.value
    const issues = result.issues
    const lines: string[] = [
      `# AI 评审报告：${reportTitle}`,
      '',
      `- 风险等级：${AI_RISK_META[result.riskLevel].label}`,
      `- 核验规范：${result.ruleSetName ? `「${result.ruleSetName}」` : ''}${result.ruleCount} 条`,
      `- 模型：${result.model}`,
      `- 评审时间：${dayjs(result.reviewedAt).format('YYYY-MM-DD HH:mm')}`,
      '',
      '## 分析结果',
      '',
      result.summary,
      '',
      `本次共分析 ${stats.totalFiles} 个变更文件，其中 ${stats.issueFileCount} 个文件发现问题：高风险 ${stats.high} · 中风险 ${stats.medium} · 低风险 ${stats.low}`,
    ]

    const checks = result.previousChecks ?? []
    if (checks.length > 0) {
      const fixed = checks.filter((check) => check.status === 'fixed').length
      const partial = checks.filter((check) => check.status === 'partial').length
      lines.push(
        '',
        '## 修复对比',
        '',
        `对比基准：${dayjs(result.comparedWith ?? 0).format('YYYY-MM-DD HH:mm')} · 已修复 ${fixed} · 部分修复 ${partial} · 未修复 ${checks.length - fixed - partial}`,
        '',
        '| 状态 | 位置 | 上次问题 | 复核说明 |',
        '| --- | --- | --- | --- |',
        ...checks.map((check) => {
          const row = [
            PREV_STATUS_META[check.status].label,
            `\`${check.file}:${check.line}\``,
            `[${AI_SEVERITY_META[check.severity].label}·${AI_ISSUE_TYPE_META[check.type].label}] ${mdCell(check.comment)}`,
            mdCell(check.note ?? ''),
          ]
          return `| ${row.join(' | ')} |`
        }),
      )
    }

    lines.push('', '## 问题清单', '')
    if (issues.length === 0) {
      lines.push('未发现问题。')
    } else {
      lines.push(
        `共 ${issues.length} 个问题：严重 ${issues.filter((issue) => issue.severity === 'high').length} · 一般 ${issues.filter((issue) => issue.severity === 'medium').length} · 轻微 ${issues.filter((issue) => issue.severity === 'low').length}`,
        '',
      )
      const groups = new Map<string, AiIssue[]>()
      for (const issue of issues) {
        const group = groups.get(issue.file)
        if (group) group.push(issue)
        else groups.set(issue.file, [issue])
      }
      const ranked = [...groups.entries()]
        .map(([file, list]) => ({
          file,
          list,
          maxWeight: Math.max(...list.map((issue) => SEVERITY_WEIGHT[issue.severity])),
          score: list.reduce((sum, issue) => sum + SEVERITY_WEIGHT[issue.severity], 0),
        }))
        .sort(compareGroupRisk)
      for (const { file, list: group } of ranked) {
        const count = (severity: AiIssueSeverity) =>
          group.filter((issue) => issue.severity === severity).length
        lines.push(`### ${file}（严重 ${count('high')} · 一般 ${count('medium')} · 轻微 ${count('low')}）`, '')
        group.forEach((issue, index) => {
          const exempt = flow.recordOf(issue)?.disposition === 'exempt' ? '［已豁免］' : ''
          lines.push(
            `${index + 1}. **[${AI_SEVERITY_META[issue.severity].label}·${AI_ISSUE_TYPE_META[issue.type].label}]**${exempt} \`${issue.file}:${issue.line}\``,
            `   - 问题：${mdCell(issue.comment)}`,
          )
          if (issue.suggestion) lines.push(`   - 建议：${mdCell(issue.suggestion)}`)
        })
        lines.push('')
      }
    }

    let target: string | null
    try {
      target = await save({
        title: '导出评审报告',
        defaultPath: flow.exportFilename.value,
        filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
      })
    } catch {
      message.error('打开保存对话框失败')
      return
    }
    if (!target) return
    try {
      await writeTextFile(target, lines.join('\n'))
    } catch {
      message.error('写入文件失败，请检查保存位置的写权限')
      return
    }
    message.success(`评审报告已保存：${target}`)
  }

  return { exportMarkdown }
}
