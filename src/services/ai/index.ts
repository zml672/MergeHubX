/** AI 评审服务统一出口：外部模块一律 `from '../services/ai'` 导入，子模块划分属于内部实现细节。
 *  本文件保持与拆分前 ai.ts 完全一致的公共 API（纯移动代码重构，外部 import 路径不变） */

// 编排与协议
export { reviewPullRequest, buildResumeFingerprint } from './engine'
export type { AiReviewEvent, AiReviewListener, ReviewPullRequestOptions } from './engine'
export type { FileContentFetcher } from './verify'

// 分批规划
export { buildBatchPlan, estimateReviewPlan } from './batching'
export type { AiReviewMode, BatchPlan } from './batching'

// 模型客户端
export {
  chatCompletion,
  chatCompletionStream,
  isReviewCancelled,
  ReviewCancelledError,
  testAiConnection,
} from './client'
export type {
  ChatMessage,
  ReviewCancelHandle,
  StreamProgress,
  StreamResult,
  StreamStats,
  TokenUsage,
} from './client'

// 错误友好化
export { friendlyAiError } from './errors'

// 结果归一化与闭环
export { closeIssueLoop, parseReviewContent } from './merge'

// 提交说明生成
export { generateCommitMessage } from './commit'

// 治理提炼
export { parseSummaryOutput, summarizeGovernanceRules } from './governance'
export type { GovernanceSummaryInput, GovernanceSummaryProgress } from './governance'
