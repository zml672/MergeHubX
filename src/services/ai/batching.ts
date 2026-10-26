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
  /** 本段覆盖的新文件行号区间（含端点，由 hunk 头解析）；0 表示无覆盖信息
   *  （patch 无合法 hunk 头，或段内不含任何上下文/新增行——如整段皆为删除行）。
   *  上轮清单按此区间分发到批次（previousIssuesForBatch），并用于合并时按证据采信核对结论 */
  newLineFrom: number
  newLineTo: number
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

/** patch 逐行扫描记录：行起始/结束偏移（相对 patch 开头）与该行占用的新文件行号 */
interface PatchLineRec {
  offset: number
  /** 行内容结束偏移（不含换行符）：超长行被硬切跨块时，覆盖判定靠 [offset, end) 与块区间重叠 */
  end: number
  /** 上下文/新增行占用的新文件行号；其余行（hunk 头、删除行、diff 文件头、No newline 标记）为 null */
  newLine: number | null
}

/**
 * 预扫描整个 patch（纯函数）：逐行计算每行占用的新文件行号。hunk 头（@@ -a,b +c,d @@）
 * 更新新行游标；上下文与新增行（空格/+ 前缀）占用游标并前移；删除行（-）与空行不占用。
 * 首个合法 hunk 头出现前游标恒为 0，diff 文件头（+++ b/… 等）虽有 +/- 前缀也不会误计。
 * 必须整 patch 扫一次而非逐段解析：块边界可能落在 hunk 中间（续切式切块），单独解析某段
 * 会丢前序块里的 hunk 头导致该段行号全部失效；整扫后游标天然连续，各段按字符区间取行即可。
 * 每行额外记录内容结束偏移（不含换行符）：超长行（窗口内无换行）被 prepareChunks 硬切在
 * 行中间时，覆盖判定靠 [offset, end) 与块区间的重叠而非仅行首归属，保证持有该行后半部分
 * 的块同样计入该行号覆盖——否则该行问题恰好落进本方案要根治的盲批核对。
 */
function scanPatchNewLines(patch: string): PatchLineRec[] {
  const recs: PatchLineRec[] = []
  let cursor = 0
  let offset = 0
  const rows = patch.split('\n')
  // 尾部伪行判定：patch 以换行结尾时，split 产出的最后一个空串是切分伪影而非 diff 行，
  // 不得计入（否则末行行号虚增）；真实空上下文行（行中间的空串）则占行号照常推进
  const realRowCount = patch.endsWith('\n') ? rows.length - 1 : rows.length
  for (let i = 0; i < realRowCount; i += 1) {
    const rawLine = rows[i]
    const start = offset
    const end = start + rawLine.length
    offset = end + 1
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('@@')) {
      const m = /\+(-?\d+)(?:,(\d+))?/.exec(line)
      cursor = m ? Math.max(0, Number.parseInt(m[1], 10)) : 0
      recs.push({ offset: start, end, newLine: null })
      continue
    }
    // 空串视为上下文行：部分平台裁剪尾随空白后把空上下文行输出为空字符串（无前缀
    // 空格），它占用一个新文件行号——不推进游标会使其后所有行行号系统性偏小。
    // cursor > 0 守卫保证 hunk 头之前/之间的空行（diff 文件头区域）不计
    if ((line.startsWith('+') || line.startsWith(' ') || line === '') && cursor > 0) {
      recs.push({ offset: start, end, newLine: cursor })
      cursor += 1
      continue
    }
    recs.push({ offset: start, end, newLine: null })
  }
  return recs
}

/**
 * 计算字符区间 [start, end) 所覆盖 diff 行占用的新文件行号区间（含端点）；无占用返回 [0, 0]。
 * 归属判定用行区间 [offset, end) 与块区间的**重叠**而非行首落段：超长行被硬切跨块时，
 * 行首在前一块、行尾在当前块，两端都算看到该行（重叠即覆盖，宁可多盖不可漏盖）。
 */
function newLineRangeOf(recs: PatchLineRec[], start: number, end: number): [number, number] {
  let from = 0
  let to = 0
  for (const rec of recs) {
    if (rec.end <= start) continue
    if (rec.offset >= end) break
    if (rec.newLine !== null) {
      if (from === 0 || rec.newLine < from) from = rec.newLine
      if (rec.newLine > to) to = rec.newLine
    }
  }
  return [from, to]
}

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
    const lineRecs = scanPatchNewLines(patch)
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
      const [newLineFrom, newLineTo] = newLineRangeOf(lineRecs, prevEnd, end)
      chunks.push({
        file,
        part,
        totalParts,
        content: patch.slice(prevEnd, end),
        truncated: totalParts < fullParts,
        newLineFrom,
        newLineTo,
      })
      prevEnd = end
    }
  }
  return chunks
}

/** 单批次的行号覆盖索引：文件路径 → 本批各段的行号区间列表。
 *  键存在但数组为空 = 文件在本批、但无行号覆盖信息（整段删除/脏 diff）；
 *  键不存在 = 文件不在本批。三种态缺一不可，分发与取信都依赖此区分 */
export interface BatchCoverage {
  /** 文件 → 行号区间列表（含端点；newLineFrom=0 的段不计入区间，但文件键仍记录） */
  ranges: Map<string, [number, number][]>
}

/** 从批次方案构建每批的行号覆盖索引（纯函数）：供清单分发与核对结论按证据取信共用 */
export function buildBatchCoverage(plan: BatchPlan): BatchCoverage[] {
  return plan.batches.map((batch) => {
    const ranges = new Map<string, [number, number][]>()
    for (const chunk of batch.chunks) {
      const list = ranges.get(chunk.file.path)
      if (list) {
        if (chunk.newLineFrom > 0) list.push([chunk.newLineFrom, chunk.newLineTo])
      } else {
        ranges.set(
          chunk.file.path,
          chunk.newLineFrom > 0 ? [[chunk.newLineFrom, chunk.newLineTo]] : [],
        )
      }
    }
    return { ranges }
  })
}

/** 行号区间命中判定：line=0（文件级问题，无位置锚点）不算命中 */
function rangeHit(ranges: [number, number][], line: number): boolean {
  if (line <= 0) return false
  return ranges.some(([from, to]) => line >= from && line <= to)
}

/**
 * 上轮清单按行号覆盖分发到批次（纯函数）：
 * 只把「本批次 diff 真正覆盖到该问题位置」的问题发给该批，消灭「盲批核对」——
 * 此前仅按文件路径过滤，大文件跨批时每个批次都收到该文件全部问题，
 * 看不见修改位置的批次只能猜 not_fixed，合并时悲观结论覆盖真实 fixed。
 * 分发规则：① 命中任一区间 → 分发；② line=0 的文件级问题 → 发给所有含该文件的批次
 * （文件级结论整文件可判）；③ 文件在本批但无任何行号覆盖信息（空数组，如纯删除文件
 * 或脏 diff）→ 退回文件级语义整文件分发（有依据总比无依据盲猜强）；④ 文件不在本批 → 不分发
 */
export function previousIssuesForBatch(
  previousIssues: AiIssue[],
  coverage: BatchCoverage,
): AiIssue[] {
  return previousIssues.filter((issue) => {
    const ranges = coverage.ranges.get(issue.file)
    if (ranges === undefined) return false
    if (issue.line <= 0) return true
    if (rangeHit(ranges, issue.line)) return true
    return ranges.length === 0
  })
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
