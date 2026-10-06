import type { AiIssue } from '../types/ai'

/** 计算问题指纹：文件路径 + 压缩空白后的描述。
 * 行号不参与匹配——重新分析时行号会漂移，参与匹配会导致治理记录与「上轮已报」角标失效 */
export function issueFingerprint(issue: Pick<AiIssue, 'file' | 'comment'>): string {
  return `${issue.file}|${issue.comment.replace(/\s+/g, ' ').trim()}`
}
