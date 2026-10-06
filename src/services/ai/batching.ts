/** diff 分批规划（纯函数）：按行边界无缝切块、生成文件排除、目录聚类装箱、全局变更清单与批次 prompt 组装 */

import { buildExemptionRulesSection, buildExemptRecordsSection, buildRulesSection } from './prompts'
import type { AiIssue, GovernanceRecord, ReviewRule } from '../../types/ai'
import type { DiffFile, PullRequestDetail } from '../../types/platform'

/** AI 分析模式：budget=预算优先（截断超额部分），full=全量分析（只求完整覆盖，不计 token 成本） */
export type AiReviewMode = 'budget' | 'full'

/** 单个 diff 块的目标大小：大文件按此粒度切块，分摊到多个批次分析 */
const CHUNK_SIZE = 8 * 1024
/** 单个文件最多切出的块数（超出部分截断），4 块 ≈ 32KB 分析预算 */
const MAX_PARTS_PER_FILE = 4
const BATCH_PATCH_BUDGET = 20 * 1024
const GENERATED_PATH_PATTERNS = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i,
  /(^|\/)(node_modules|vendor|dist|build)\//,
  /\.min\.(js|css)$/i,
  /\.map$/i,
]

function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((p) => p.test(path))
}

/** diff 分析的最小单元：大文件的 diff 按行切成多块，分摊到不同批次中分析 */
interface PatchChunk {
  file: DiffFile
  /** 当前块序号（从 1 开始）与该文件切分后的总块数 */
  part: number
  totalParts: number
  content: string
  /** 文件完整 diff 超出总块数所能覆盖的范围（被截断） */
  truncated: boolean
}

interface FileBatch {
  chunks: PatchChunk[]
  chars: number
}

/** 单个文件在所有批次中的 diff 覆盖情况（用于变更清单标注） */
interface FileCoverage {
  parts: number
  totalParts: number
  truncated: boolean
}

type ExcludedReason = 'generated'

interface ExcludedFile {
  file: DiffFile
  reason: ExcludedReason
}

export interface BatchPlan {
  batches: FileBatch[]
  manifestFiles: DiffFile[]
  excluded: ExcludedFile[]
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '（根目录）' : path.slice(0, idx)
}

/**
 * 把每个文件的 diff 按行对齐切成 CHUNK_SIZE 大小的块，避免 diff 行被拦腰截断导致解析混乱。
 * 切点采用续切式：下一块起点 = 上一块的实际终点（行边界），块间无缝衔接——若按固定网格
 * 起点切块，行对齐裁尾会在块间残留缝隙，边界处的 diff 内容被静默丢弃，评审可能漏掉恰好
 * 落在缝隙里的问题。终点前无换行可对齐时（如超长单行 diff）按 CHUNK_SIZE 硬切，退化为
 * 行中截断但依然无缝。
 * budget 模式单文件最多切 MAX_PARTS_PER_FILE 块（约 32KB 分析预算），达到上限即止算边界
 * ——不为整块被丢弃的尾部继续计算；full 模式不封顶块数，切到覆盖完整 diff 为止。
 * 两种模式的行边界查找都是窗口限界回扫（见循环内注释），总代价恒为 O(diff 长度)。
 */
function prepareChunks(pr: PullRequestDetail, mode: AiReviewMode): PatchChunk[] {
  const chunks: PatchChunk[] = []
  for (const file of pr.files) {
    if (!file.patch) continue
    const patch = file.patch
    const maxParts = mode === 'full' ? Number.POSITIVE_INFINITY : MAX_PARTS_PER_FILE
    // 先按续切方式算出块终点：起点接续上一块终点，终点尽量对齐到行边界。
    // 行边界查找限定在当前块窗口内回扫：窗口内有换行时扫描距离与 lastIndexOf 相同；
    // 窗口内无换行时 lastIndexOf 会继续贯穿整个前缀（无换行超大 patch 下为
    // O(段数×长度) 平方级），窗口限界回扫到 start 即停，总代价恒为 O(长度)
    const bounds: number[] = []
    let start = 0
    while (start < patch.length && bounds.length < maxParts) {
      let end = Math.min(start + CHUNK_SIZE, patch.length)
      if (end < patch.length) {
        let nl = -1
        for (let i = end; i > start; i--) {
          if (patch.charCodeAt(i) === 10 /* \n */) {
            nl = i
            break
          }
        }
        if (nl > start) end = nl + 1
      }
      bounds.push(end)
      start = end
    }
    // 因段数上限提前止算时，尾部至少还剩一块未计入：fullParts 记为「上限+1」仅用于
    // truncated 判定（真实段数不再计算），不进入任何 chunk 字段
    const fullParts = bounds.length + (start < patch.length ? 1 : 0)
    const totalParts = mode === 'full' ? fullParts : Math.min(fullParts, MAX_PARTS_PER_FILE)
    let prevEnd = 0
    for (let part = 1; part <= totalParts; part += 1) {
      const end = bounds[part - 1]
      chunks.push({
        file,
        part,
        totalParts,
        content: patch.slice(prevEnd, end),
        truncated: totalParts < fullParts,
      })
      prevEnd = end
    }
  }
  return chunks
}

export function buildBatchPlan(pr: PullRequestDetail, mode: AiReviewMode): BatchPlan {
  const generated: DiffFile[] = []
  const analyzed: PatchChunk[] = []
  for (const chunk of prepareChunks(pr, mode)) {
    if (isGeneratedPath(chunk.file.path)) {
      if (chunk.part === 1) generated.push(chunk.file)
      continue
    }
    analyzed.push(chunk)
  }
  const groups = new Map<string, PatchChunk[]>()
  for (const chunk of analyzed) {
    const dir = dirOf(chunk.file.path)
    const list = groups.get(dir)
    if (list) list.push(chunk)
    else groups.set(dir, [chunk])
  }
  const orderedChunks = [...groups.entries()]
    .map(([, chunks]) => ({
      chunks,
      total: chunks.reduce((sum, c) => sum + c.content.length, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .flatMap((d) =>
      d.chunks.sort((a, b) => a.file.path.localeCompare(b.file.path) || a.part - b.part),
    )
  const batches: FileBatch[] = []
  let current: FileBatch = { chunks: [], chars: 0 }
  for (const chunk of orderedChunks) {
    const cost = chunk.content.length + chunk.file.path.length + 100
    if (current.chunks.length > 0 && current.chars + cost > BATCH_PATCH_BUDGET) {
      batches.push(current)
      current = { chunks: [], chars: 0 }
    }
    current.chunks.push(chunk)
    current.chars += cost
  }
  if (current.chunks.length > 0) batches.push(current)
  const excluded: ExcludedFile[] = generated.map((file) => ({
    file,
    reason: 'generated' as const,
  }))
  // 批次数不封顶：任何文件都不会因容量不足被整体跳过，
  // 预算模式靠单文件段数上限（MAX_PARTS_PER_FILE）截断控制成本
  return { batches, manifestFiles: pr.files, excluded }
}

export function buildManifest(plan: BatchPlan): string {
  const coverage = new Map<string, FileCoverage>()
  for (const batch of plan.batches) {
    for (const chunk of batch.chunks) {
      const existing = coverage.get(chunk.file.path)
      if (existing) {
        existing.parts += 1
        existing.totalParts = Math.max(existing.totalParts, chunk.totalParts)
        existing.truncated = existing.truncated || chunk.truncated
      } else {
        coverage.set(chunk.file.path, {
          parts: 1,
          totalParts: chunk.totalParts,
          truncated: chunk.truncated,
        })
      }
    }
  }
  const excludedMap = new Map(plan.excluded.map((e) => [e.file.path, e.reason]))
  const lines = plan.manifestFiles.map((f) => {
    const meta = `${f.status}，+${f.additions} -${f.deletions}`
    const cov = coverage.get(f.path)
    if (cov) {
      // 装箱不封顶：纳入分析的文件其块全部入批，parts 恒等于 totalParts，不存在「部分覆盖」态，
      // 截断信息由 truncated 承载；若未来引入批次数上限使部分块不入批，需在此恢复
      // 「diff 分 X 段，本次覆盖前 Y 段」的覆盖差距分支
      if (cov.truncated) {
        return `- ${f.path}（${meta}）· 已纳入分批分析（diff 过长，已截取前 ${cov.parts} 段）`
      }
      return `- ${f.path}（${meta}）· 已纳入分批分析`
    }
    const reason = excludedMap.get(f.path)
    if (reason === 'generated') return `- ${f.path}（${meta}）· 自动生成/锁定文件，无需评审`
    return `- ${f.path}（${meta}）· 无文本 diff（可能为二进制或超大文件），未纳入本次分析`
  })
  return ['## 全局变更清单（本次全部变更文件）', ...lines].join('\n')
}

export function buildBatchPrompt(
  pr: PullRequestDetail,
  rules: ReviewRule[],
  manifest: string,
  batch: FileBatch,
  batchIndex: number,
  totalBatches: number,
  previousIssues: AiIssue[],
  exempt: GovernanceRecord[],
): string {
  const sections: string[] = []
  sections.push(
    [
      '## 评审维度',
      '1. 缺陷（bug）：逻辑错误、边界条件、空值与异常处理、并发与状态问题',
      '2. 安全（security）：注入风险、敏感信息泄漏、权限校验缺失',
      '3. 性能（performance）：明显的复杂度问题、重复计算、资源泄漏风险',
      '4. 风格（style）：可读性、命名、重复代码、死代码',
    ].join('\n'),
  )
  const rulesSection = buildRulesSection(rules)
  if (rulesSection) sections.push(rulesSection)
  const exemptionSection = buildExemptionRulesSection(rules)
  if (exemptionSection) sections.push(exemptionSection)
  const exemptSection = buildExemptRecordsSection(exempt)
  if (exemptSection) sections.push(exemptSection)
  sections.push(
    [
      '## 合并请求信息',
      `- 标题：${pr.title}`,
      `- 编号：#${pr.number}`,
      `- 作者：${pr.author}`,
      `- 分支：${pr.sourceBranch} → ${pr.targetBranch}`,
      `- 描述：${pr.body.trim() || '（无描述）'}`,
    ].join('\n'),
  )
  sections.push(manifest)
  if (previousIssues.length > 0) {
    sections.push(
      [
        `## 上次评审发现的问题（共 ${previousIssues.length} 条，请逐条核对修复情况）`,
        ...previousIssues.map(
          (issue, i) =>
            `${i + 1}. [${issue.severity}/${issue.type}] ${issue.file}:${issue.line} — ${issue.comment}`,
        ),
      ].join('\n'),
    )
  }
  const byPath = new Map<string, PatchChunk[]>()
  for (const chunk of batch.chunks) {
    const list = byPath.get(chunk.file.path)
    if (list) list.push(chunk)
    else byPath.set(chunk.file.path, [chunk])
  }
  const parts = [...byPath.values()].map((chunks) => {
    chunks.sort((a, b) => a.part - b.part)
    const first = chunks[0]
    const { file } = first
    const header = `### 文件: ${file.path}（${file.status}，+${file.additions} -${file.deletions}）`
    const body = chunks
      // 段标记以「该文件总段数」为条件（first.totalParts）而非本批段数：文件被切成
      // 多段但被装箱拆到不同批次时，某批可能只含其 1 段——此时模型更需知道看到的是
      // 全文第几段，不能因本批只有一段就省略标记
      .map((c) =>
        first.totalParts > 1 ? `【第 ${c.part}/${c.totalParts} 段】\n${c.content}` : c.content,
      )
      .join('')
    const partial = chunks.length < first.totalParts
    const patch = partial
      ? `${body}\n…（该文件 diff 共 ${first.totalParts} 段，本批仅含 ${chunks.length} 段）`
      : first.truncated
        ? `${body}\n…（diff 过长，后续内容未纳入本次分析）`
        : body
    return `${header}\n\`\`\`diff\n${patch}\n\`\`\``
  })
  sections.push(
    [
      `## 变更 diff（第 ${batchIndex + 1}/${totalBatches} 批，共 ${byPath.size} 个文件、${batch.chunks.length} 段 diff）`,
      '说明：超大文件的 diff 会被切成多段分摊到不同批次；各文件的实际覆盖范围以全局变更清单标注为准，未覆盖部分不代表不存在问题。',
      ...parts,
    ].join('\n\n'),
  )
  return sections.join('\n\n')
}

/**
 * 预估给定分析模式下的批次方案（纯字符串运算、不发起请求），用于模式选择弹窗的实时预览。
 */
export function estimateReviewPlan(pr: PullRequestDetail, mode: AiReviewMode) {
  const plan = buildBatchPlan(pr, mode)
  const analyzedFiles = new Set(
    plan.batches.flatMap((b) => b.chunks.map((c) => c.file.path)),
  ).size
  return {
    batches: plan.batches.length,
    analyzedFiles,
    excludedFiles: plan.excluded.length,
  }
}
