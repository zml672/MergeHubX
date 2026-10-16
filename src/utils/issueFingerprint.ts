import type { AiIssue } from '../types/ai'

/** 计算问题指纹（精确）：文件路径 + 压缩空白后的描述。
 * 行号不参与匹配——重新分析时行号会漂移，参与匹配会导致治理记录与「上轮已报」角标失效 */
export function issueFingerprint(issue: Pick<AiIssue, 'file' | 'comment'>): string {
  return `${issue.file}|${issue.comment.replace(/\s+/g, ' ').trim()}`
}

/** 行号桶宽：宽松指纹的行号容差。模型重报同一问题时行号常有小幅漂移（±2 行内），
 * 分桶后落在同桶即视为同一位置；桶边界处的相邻行会落入不同桶（接受此误差，偏置原则：宁漏拦不误拦） */
const LINE_BUCKET_SIZE = 5

/** 脏行号哨兵桶（P1-15① 评审 #20）：非有限或小于 1 的行号（0、负数、NaN、0~1 小数）不可信，
 * 独立归入哨兵桶 -1，不与真实 1~5 行（桶 0）碰撞——否则脏行号问题会误命中同文件同类型的
 * 真实行号治理记录造成误拦，与「宁漏拦不误拦」偏置相悖。
 * 真实行号 floor((line-1)/5) 在 line>=1 时恒 >= 0，哨兵 -1 不会与任何真实桶冲突；
 * 脏数据彼此共享哨兵桶可接受：它们本就无位置信息，同桶残留的互撞风险由上游处置冲突检查兜底 */
const DIRTY_LINE_BUCKET = -1

/** 计算行号桶号：仅对 line >= 1 走 floor 分桶，脏行号归哨兵桶 */
function lineBucket(line: number): number {
  if (!Number.isFinite(line) || line < 1) return DIRTY_LINE_BUCKET
  return Math.floor((line - 1) / LINE_BUCKET_SIZE)
}

/** 计算问题指纹（宽松）：文件路径 + 问题类型 + 行号桶的明文键。
 * P1-15①：措辞漂移兜底——模型换说法重报同一问题时精确指纹失配，宽松指纹不看描述文本，
 * 只要同文件同类型同位置桶即命中，治理匹配以此拦截「换皮复活」的旧问题。
 * 哈希段已移除（P1-15① 评审 #18）：匹配靠整串相等，明文已含全部匹配组件，哈希是纯装饰，
 * 且它引入了 utils→services 反向依赖（utils 不应依赖 services 层）。
 * 前置依赖：调用方需已执行行号重定位（confirmed/relocated 的 line 为程序可信坐标）；
 * unlocatable 的行号未经校验，宽松指纹照常计算，脏行号归哨兵桶与真实行号隔离（评审 #20）。
 * 注意：宽松指纹仅作治理匹配的补充命中，不替代精确指纹（评论去重、上轮对比仍以精确为准） */
export function looseIssueFingerprint(issue: Pick<AiIssue, 'file' | 'type' | 'line'>): string {
  const bucket = lineBucket(issue.line)
  return `loose:${issue.file}|${issue.type}|${bucket}`
}

/** 双指纹：同时返回精确与宽松指纹（治理记录写入与匹配共用，保证两侧口径单源） */
export function issueFingerprints(issue: AiIssue): { exact: string; loose: string } {
  return { exact: issueFingerprint(issue), loose: looseIssueFingerprint(issue) }
}
