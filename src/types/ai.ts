export interface AiPreset {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  needsKey: boolean
  keyUrl?: string
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    needsKey: true,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'qwen',
    label: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    needsKey: true,
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    needsKey: true,
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地模型）',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    needsKey: false,
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    needsKey: true,
  },
]

export function aiPresetOf(presetId: string): AiPreset {
  return AI_PRESETS.find((p) => p.id === presetId) ?? AI_PRESETS[0]
}

export interface AiModelConfig {
  baseUrl: string
  model: string
  apiKey: string
  /** 批次评审并发数，默认 2；调大可缩短总耗时，但过大会触发 API 限流 */
  concurrency?: number
}

export interface AiModelProfile {
  id: string
  name: string
  presetId: string
  baseUrl: string
  model: string
  concurrency?: number
}

export type AiRiskLevel = 'low' | 'medium' | 'high'

export type AiIssueSeverity = AiRiskLevel

export type AiIssueType =
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'convention'

export interface AiIssue {
  file: string
  line: number
  severity: AiIssueSeverity
  type: AiIssueType
  comment: string
  /** 具体修复建议（中文），模型可选输出 */
  suggestion?: string
  /** 第二遍复核判为误报的原因（仅被过滤的问题携带，供复核摘要明细展示） */
  verifyReason?: string
}

/** 上次问题的复核结论 */
export type AiIssueStatus = 'fixed' | 'partial' | 'not_fixed'

/** 重测时对上次单个问题的逐条核对结果 */
export interface AiPreviousCheck {
  file: string
  line: number
  severity: AiIssueSeverity
  type: AiIssueType
  comment: string
  status: AiIssueStatus
  /** 复核说明（中文一句话） */
  note?: string
}

export interface AiReviewResult {
  summary: string
  riskLevel: AiRiskLevel
  issues: AiIssue[]
  degraded: boolean
  reviewedAt: number
  model: string
  ruleCount: number
  ruleSetName?: string
  /** 与上次评审对比：上次问题逐条核对结果 */
  previousChecks?: AiPreviousCheck[]
  /** 对比基准（上次评审的 reviewedAt），无对比时缺省 */
  comparedWith?: number
  /** 第二遍对抗式复核统计：对报过问题的文件取全文验证证据；未执行复核时缺省 */
  verify?: {
    /** 复核后模型显式确认成立的问题数（未获显式结论的不计入） */
    confirmed: number
    /** 被完整代码推翻、判定疑似误报而过滤的问题数 */
    filtered: number
    /** 未获显式结论（输出异常/取证失败/模型未表态）与未下发（截断剔除）的条目数；旧持久化结果缺省 */
    unverified?: number
    /** 被过滤问题的明细 */
    filteredIssues: AiIssue[]
    /** 复核调用失败的文件数（>0 说明部分或全部结论未能产出）；旧持久化结果缺省 */
    failedFiles?: number
  }
}

export interface AiReviewUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type AiReviewStepStatus = 'pending' | 'running' | 'done' | 'error' | 'canceled'

export interface AiReviewStep {
  key: string
  title: string
  status: AiReviewStepStatus
  detail: string
  startedAt: number
  endedAt: number
}

export interface AiReviewRunLog {
  steps: AiReviewStep[]
  startedAt: number
  endedAt: number
  done: boolean
  canceled?: boolean
  error: string
  totalBatches: number
  sentChars: number
  answerChars: number
  reasoningChars: number
  usage: AiReviewUsage
}

/** 断点续跑信息：error 中断后保留已完成批次的结果，供「继续分析」滚动续跑 */
export interface AiReviewResumePoint {
  /** 批次计划指纹（模型标识+模式+规则集+批次结构），续跑前比对，失配即作废断点 */
  fingerprint: string
  totalBatches: number
  /** 批次号（从 1 开始）→ 该批次评审结果 */
  results: Record<number, AiReviewResult>
  /** 断点最后写入时间（用于多评审间 FIFO 淘汰） */
  savedAt: number
}

export const AI_RISK_META: Record<AiRiskLevel, { label: string; color: string }> = {
  low: { label: '低风险', color: 'green' },
  medium: { label: '中风险', color: 'orange' },
  high: { label: '高风险', color: 'red' },
}

export const AI_SEVERITY_META: Record<AiIssueSeverity, { label: string; color: string }> = {
  low: { label: '轻微', color: 'blue' },
  medium: { label: '一般', color: 'orange' },
  high: { label: '严重', color: 'red' },
}

export const AI_ISSUE_TYPE_META: Record<AiIssueType, { label: string; color: string }> = {
  bug: { label: '缺陷', color: 'red' },
  security: { label: '安全', color: 'volcano' },
  performance: { label: '性能', color: 'orange' },
  style: { label: '风格', color: 'blue' },
  convention: { label: '规范', color: 'purple' },
}

/** 规则语义类型：standard 为要求遵守的规范（含遵守记录提炼）；exemption 为豁免（要求模型不再报告） */
export type RuleKind = 'standard' | 'exemption'

/** 治理记录处置类型：exempt 豁免（误报/可接受，屏蔽重复报告）；comply 遵守（有效问题，提炼为规范后逐条核验） */
export type IssueDisposition = 'exempt' | 'comply'

/** 规则来源：manual 手工创建；exempt-sediment 由豁免记录提炼；comply-sediment 由遵守记录提炼；ai-summary 由 AI 提炼生成 */
export type RuleSourceKind = 'manual' | 'exempt-sediment' | 'comply-sediment' | 'ai-summary'

/** 规则来源与沉淀溯源：items 为提炼时刻的治理记录快照（记录后续被删除溯源仍完整）；旧数据缺省按手工创建处理 */
export interface RuleSource {
  kind: RuleSourceKind
  /** 提炼来源范围：'general' 为通用层，否则为仓库名 */
  repo?: string
  items: {
    /** 该条记录的生效范围：'general' 或仓库名 */
    scope: string
    file: string
    line: number
    /** 与 GovernanceRecord.type 对齐为枚举类型：快照在提炼时刻从治理记录拷贝，编译期约束防构造点写入枚举外值（展示侧对旧数据仍留兜底） */
    type: AiIssueType
    comment: string
    recordedAt: number
    /** 提炼时用户针对该条记录写的评论，随记录提交给 AI 并留档溯源 */
    note?: string
  }[]
  createdAt: number
}

export interface ReviewRule {
  id: string
  name: string
  enabled: boolean
  content: string
  kind: RuleKind
  source?: RuleSource
}

export interface RuleSet {
  id: string
  name: string
  rules: ReviewRule[]
}

/** 治理记录：审阅侧加入豁免/遵守的 AI 评审问题，跨分析持久生效，统一在治理工作台管理与提炼 */
export interface GovernanceRecord {
  id: string
  /** 记录指纹：文件 + 归一化描述（不含行号，容忍重新分析时的行号漂移） */
  fingerprint: string
  /** 生效范围：'general' 为通用（跨仓库生效），否则为仓库名 */
  scope: string
  /** 处置类型：豁免或遵守 */
  disposition: IssueDisposition
  file: string
  /** 记录时的行号，仅用于展示，不参与匹配 */
  line: number
  type: AiIssueType
  comment: string
  recordedAt: number
  /** 处置理由：处置时采集的说明（缺省回填复核误报原因，可留空）；旧数据缺省不展示 */
  reason?: string
  /** 沉淀回执：已提炼为规范规则时回写（规则侧以 source.items 快照反向溯源）；缺省视为未沉淀 */
  sedimentedTo?: SedimentLink
}

/** 治理记录 → 规范规则的提炼链接 */
export interface SedimentLink {
  ruleId: string
  ruleName: string
  at: number
}
