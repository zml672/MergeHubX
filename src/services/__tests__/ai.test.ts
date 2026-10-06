import { describe, expect, it } from 'vitest'
import {
  buildBatchPlan,
  buildResumeFingerprint,
  closeIssueLoop,
  friendlyAiError,
  parseReviewContent,
  parseSummaryOutput,
} from '../ai'
import { buildBatchPrompt } from '../ai/batching'
import { isRetryableNetworkError } from '../ai/engine'
import type { AiIssue, AiModelConfig, AiPreviousCheck, ReviewRule } from '../../types/ai'
import type { DiffFile, PullRequestDetail } from '../../types/platform'

/** 每行固定 1000 字符（999 个字符 + 换行）的 diff 文本，用于精确控制分块边界 */
function lines(count: number, ch = 'a'): string {
  return `${ch.repeat(999)}\n`.repeat(count)
}

function makeFile(patch: string, path = 'src/a.ts'): DiffFile {
  return { path, status: 'modified', additions: 10, deletions: 2, patch }
}

function makePr(files: DiffFile[]): PullRequestDetail {
  return {
    key: 'github:o/r#1',
    platform: 'github',
    repo: 'o/r',
    number: 1,
    title: 't',
    author: 'a',
    state: 'open',
    sourceBranch: 'feature',
    targetBranch: 'main',
    fromFork: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: '',
    body: '',
    additions: 0,
    deletions: 0,
    changedFiles: files.length,
    files,
  }
}

const config: AiModelConfig = { baseUrl: 'https://api.test.com/v1', model: 'model-x', apiKey: 'k' }

const rules: ReviewRule[] = [
  { id: 'r1', name: '命名规范', enabled: true, content: '变量命名清晰', kind: 'standard' },
]

describe('buildBatchPlan', () => {
  it('正常路径：小文件单块成批，内容原样保留、无截断无排除', () => {
    const plan = buildBatchPlan(makePr([makeFile('line1\nline2\n')]), 'budget')
    expect(plan.batches).toHaveLength(1)
    const chunk = plan.batches[0].chunks[0]
    expect(chunk.file.path).toBe('src/a.ts')
    expect(chunk.part).toBe(1)
    expect(chunk.totalParts).toBe(1)
    expect(chunk.content).toBe('line1\nline2\n')
    expect(chunk.truncated).toBe(false)
    expect(plan.excluded).toHaveLength(0)
    expect(plan.manifestFiles).toHaveLength(1)
  })

  it('预算模式：超大文件按行边界续切并封顶 4 段，标记截断', () => {
    const patch = lines(50) // 50 × 1000 = 50000 字符，完整需 7 块
    const plan = buildBatchPlan(makePr([makeFile(patch)]), 'budget')
    const chunks = plan.batches.flatMap((b) => b.chunks)
    expect(chunks).toHaveLength(4)
    for (const chunk of chunks) {
      expect(chunk.totalParts).toBe(4)
      expect(chunk.truncated).toBe(true)
      expect(chunk.content.length).toBeLessThanOrEqual(8 * 1024)
      expect(chunk.content.endsWith('\n')).toBe(true) // 切在行边界，不截断 diff 行
    }
    // 续切式切块：下一块起点 = 上一块行对齐终点，块间无缝
    expect(chunks[0].content).toBe(patch.slice(0, 8000))
    expect(chunks[1].content).toBe(patch.slice(8000, 16000))
    expect(chunks[2].content).toBe(patch.slice(16000, 24000))
    expect(chunks[3].content).toBe(patch.slice(24000, 32000))
    expect(chunks.map((c) => c.content).join('')).toBe(patch.slice(0, 32000))
  })

  it('全量模式：不封顶块数，所有块无缝拼接完整覆盖 diff', () => {
    const patch = lines(50)
    const plan = buildBatchPlan(makePr([makeFile(patch)]), 'full')
    const chunks = plan.batches.flatMap((b) => b.chunks)
    expect(chunks).toHaveLength(7)
    for (const chunk of chunks) expect(chunk.truncated).toBe(false)
    // 无缝覆盖强断言：全部块按序拼接 === 原始 diff，任何边界处都无内容静默丢失
    expect(chunks.map((c) => c.content).join('')).toBe(patch)
    // 末块覆盖到 diff 末尾
    expect(chunks[chunks.length - 1].content).toBe(patch.slice(48000))
  })

  it('边界路径：超长单行 diff 无行边界可对齐，按块长硬切但依然无缝', () => {
    const patch = 'x'.repeat(20000)
    const plan = buildBatchPlan(makePr([makeFile(patch)]), 'full')
    const chunks = plan.batches.flatMap((b) => b.chunks)
    expect(chunks.map((c) => c.content).join('')).toBe(patch)
    expect(chunks[0].content).toHaveLength(8192)
    expect(chunks[chunks.length - 1].content).toBe(patch.slice(16384))
  })

  it('锁定文件与构建产物自动排除，业务文件不受影响', () => {
    const plan = buildBatchPlan(
      makePr([
        makeFile('x', 'package-lock.json'),
        makeFile('y', 'web/dist/bundle.min.js'),
        makeFile('z', 'node_modules/pkg/index.js'),
        makeFile('keep', 'src/app.ts'),
      ]),
      'budget',
    )
    expect(plan.excluded.map((e) => e.file.path).sort()).toEqual([
      'node_modules/pkg/index.js',
      'package-lock.json',
      'web/dist/bundle.min.js',
    ])
    for (const excluded of plan.excluded) expect(excluded.reason).toBe('generated')
    const paths = plan.batches.flatMap((b) => b.chunks.map((c) => c.file.path))
    expect(paths).toEqual(['src/app.ts'])
  })

  it('多文件装箱：每批不超 20KB 预算，任何文件的任何块都不被丢弃', () => {
    const files = [
      makeFile(lines(30), 'd1/a.ts'),
      makeFile(lines(30, 'b'), 'd1/b.ts'),
      makeFile(lines(30, 'c'), 'd2/c.ts'),
      makeFile(lines(30, 'd'), 'd2/d.ts'),
    ]
    const plan = buildBatchPlan(makePr(files), 'budget')
    expect(plan.batches.length).toBeGreaterThan(1)
    for (const batch of plan.batches) {
      expect(batch.chars).toBeLessThanOrEqual(20 * 1024)
      expect(batch.chunks.length).toBeGreaterThan(0)
    }
    const chunks = plan.batches.flatMap((b) => b.chunks)
    expect(chunks).toHaveLength(16) // 4 文件 × 各 4 块，全部纳入
    expect(new Set(chunks.map((c) => c.file.path))).toEqual(
      new Set(['d1/a.ts', 'd1/b.ts', 'd2/c.ts', 'd2/d.ts']),
    )
  })

  it('脏数据路径：空 patch 的文件不产生任何块', () => {
    const plan = buildBatchPlan(makePr([makeFile('')]), 'budget')
    expect(plan.batches).toHaveLength(0)
    expect(plan.excluded).toHaveLength(0)
    expect(buildBatchPlan(makePr([]), 'full').batches).toHaveLength(0)
  })
})

describe('buildBatchPrompt 段标记', () => {
  const pr = makePr([makeFile(lines(50))])
  const manifest = ''

  it('文件被切多段但某批仅含其 1 段时，仍输出【第 X/Y 段】标记', () => {
    // 构造跨批拆分的场景：同文件 4 段中的第 3 段孤立成批（装箱边界可产生）
    const chunkOf = (part: number) => ({
      file: pr.files[0],
      part,
      totalParts: 4,
      content: lines(3, String(part)[0] as 'a'),
      truncated: true,
    })
    const batch: Parameters<typeof buildBatchPrompt>[3] = {
      chunks: [chunkOf(3)],
      chars: 3000,
    }
    const prompt = buildBatchPrompt(pr, [], manifest, batch, 0, 4, [], [])
    expect(prompt).toContain('【第 3/4 段】')
    // 跨批拆分说明在文尾提示模型本批只含部分段
    expect(prompt).toContain('本批仅含 1 段')
  })

  it('单段文件（totalParts=1）不输出段标记', () => {
    const chunk = {
      file: pr.files[0],
      part: 1,
      totalParts: 1,
      content: 'line1\nline2\n',
      truncated: false,
    }
    const batch: Parameters<typeof buildBatchPrompt>[3] = { chunks: [chunk], chars: 12 }
    const prompt = buildBatchPrompt(pr, [], manifest, batch, 0, 1, [], [])
    expect(prompt).not.toContain('【第 ')
    expect(prompt).toContain('line1\nline2\n')
  })

  it('同批含同文件多段时，各段均带标记且按段序排列', () => {
    const chunkOf = (part: number) => ({
      file: pr.files[0],
      part,
      totalParts: 4,
      content: `${part}\n`,
      truncated: false,
    })
    const batch: Parameters<typeof buildBatchPrompt>[3] = {
      chunks: [chunkOf(2), chunkOf(1)],
      chars: 8,
    }
    const prompt = buildBatchPrompt(pr, [], manifest, batch, 0, 4, [], [])
    const idx1 = prompt.indexOf('【第 1/4 段】')
    const idx2 = prompt.indexOf('【第 2/4 段】')
    expect(idx1).toBeGreaterThanOrEqual(0)
    expect(idx2).toBeGreaterThan(idx1)
  })
})

describe('buildResumeFingerprint', () => {
  const pr = makePr([makeFile('a'.repeat(40))])

  it('正常路径：同输入产出一致指纹；传入已构建 plan 与自建 plan 等价', () => {
    const fp1 = buildResumeFingerprint(config, pr, 'budget', '规范集', rules)
    const fp2 = buildResumeFingerprint(config, pr, 'budget', '规范集', rules)
    expect(fp1).toBe(fp2)
    const plan = buildBatchPlan(pr, 'budget')
    expect(buildResumeFingerprint(config, pr, 'budget', '规范集', rules, plan)).toBe(fp1)
  })

  it('等长内容修改必须改变指纹：同长度替换文本不可逃逸', () => {
    const prA = makePr([makeFile('a'.repeat(40))])
    const prB = makePr([makeFile('b'.repeat(40))])
    expect(buildResumeFingerprint(config, prA, 'budget', 's', rules)).not.toBe(
      buildResumeFingerprint(config, prB, 'budget', 's', rules),
    )
  })

  it('换模型 / 换模式 / 换规则集 / 改规则内容 任一变化即失配', () => {
    const base = buildResumeFingerprint(config, pr, 'budget', 's', rules)
    expect(
      buildResumeFingerprint({ ...config, model: 'model-y' }, pr, 'budget', 's', rules),
    ).not.toBe(base)
    expect(buildResumeFingerprint(config, pr, 'full', 's', rules)).not.toBe(base)
    expect(buildResumeFingerprint(config, pr, 'budget', '另一套', rules)).not.toBe(base)
    const changedRules: ReviewRule[] = [{ ...rules[0], content: '新内容' }]
    expect(buildResumeFingerprint(config, pr, 'budget', 's', changedRules)).not.toBe(base)
  })
})

describe('closeIssueLoop', () => {
  const checks: AiPreviousCheck[] = [
    { file: 'a.ts', line: 1, severity: 'high', type: 'bug', comment: '空指针', status: 'not_fixed', note: '仍存在' },
    { file: 'b.ts', line: 2, severity: 'medium', type: 'performance', comment: '重复计算', status: 'partial', note: '有改进' },
    { file: 'c.ts', line: 3, severity: 'low', type: 'style', comment: '死代码', status: 'fixed' },
  ]

  it('正常路径：模型已照常列入的问题不重复补入', () => {
    const issues: AiIssue[] = [
      { file: 'a.ts', line: 1, severity: 'high', type: 'bug', comment: '空指针' },
      { file: 'b.ts', line: 2, severity: 'medium', type: 'performance', comment: '重复计算' },
    ]
    const result = closeIssueLoop(issues, checks)
    expect(result).toHaveLength(2)
    expect(result.every((i) => !i.suggestion?.includes('上轮复核备注'))).toBe(true)
  })

  it('软约束失效兜底：模型漏列的 not_fixed / partial 结论被确定性补入，fixed 不补', () => {
    const result = closeIssueLoop([], checks)
    expect(result).toHaveLength(2)
    const [first, second] = result
    expect(first).toMatchObject({
      file: 'a.ts',
      severity: 'high',
      type: 'bug',
      comment: '空指针',
      suggestion: '上轮复核备注：仍存在',
    })
    expect(second).toMatchObject({ file: 'b.ts', comment: '重复计算', suggestion: '上轮复核备注：有改进' })
    expect(result.some((i) => i.file === 'c.ts')).toBe(false)
  })

  it('指纹口径：描述仅空白差异即视为已报告，不产生重复条目', () => {
    const issues: AiIssue[] = [
      { file: 'a.ts', line: 1, severity: 'high', type: 'bug', comment: '空  指针\n' },
    ]
    const single: AiPreviousCheck[] = [checks[0]] // 只带入与该问题对应的一条核对结论
    expect(closeIssueLoop(issues, single)).toHaveLength(1)
  })

  it('宽松命中：模型复述时行号漂移、措辞改写，相似度达标不重复派生；无关新问题照常补入', () => {
    const check: AiPreviousCheck[] = [
      { file: 'a.ts', line: 10, severity: 'high', type: 'bug', comment: '存在空指针风险', status: 'not_fixed' },
    ]
    // 模型复述：行号 10→14 漂移、措辞扩写（相似度 0.75 达标）→ 视为已上报
    const reworded: AiIssue[] = [
      { file: 'a.ts', line: 14, severity: 'high', type: 'bug', comment: '此处可能存在空指针风险' },
    ]
    expect(closeIssueLoop(reworded, check)).toHaveLength(1)

    // 同文件不同位置、描述无关的真实新场景 → 派生补入，构造性保证未修复问题不缺席
    const unrelated: AiIssue[] = [
      { file: 'a.ts', line: 200, severity: 'medium', type: 'style', comment: '魔法数字应提取为常量' },
    ]
    const withDerived = closeIssueLoop(unrelated, check)
    expect(withDerived).toHaveLength(2)
    expect(withDerived.some((i) => i.line === 10 && i.comment === '存在空指针风险')).toBe(true)
  })

  it('宽松命中：行号邻近且类型一致的模型上报视为已覆盖（模型行号存在噪声）', () => {
    const check: AiPreviousCheck[] = [
      { file: 'a.ts', line: 10, severity: 'high', type: 'bug', comment: '完全不同的表述甲', status: 'not_fixed' },
    ]
    const issues: AiIssue[] = [
      { file: 'a.ts', line: 12, severity: 'high', type: 'bug', comment: '完全不同的表述乙' },
    ]
    expect(closeIssueLoop(issues, check)).toHaveLength(1)
  })

  it('相似度下限：过短核对结论（如单字泛称）不被长描述的包含关系误吞', () => {
    const check: AiPreviousCheck[] = [
      { file: 'a.ts', line: 10, severity: 'high', type: 'bug', comment: '错', status: 'not_fixed' },
    ]
    const issues: AiIssue[] = [
      {
        file: 'a.ts',
        line: 300,
        severity: 'medium',
        type: 'style',
        comment: '这里的异常处理缺少对错误码的判断，可能导致难以定位的错误',
      },
    ]
    // 「错」是长描述的子串，但过短不可信：派生补入，闭环保障不被绕过
    const withDerived = closeIssueLoop(issues, check)
    expect(withDerived).toHaveLength(2)
  })

  it('包含快速通道：被包含串达最小长度门槛时仍判相似', () => {
    const check: AiPreviousCheck[] = [
      {
        file: 'a.ts',
        line: 10,
        severity: 'high',
        type: 'bug',
        comment: '存在空指针风险可能导致程序崩溃',
        status: 'not_fixed',
      },
    ]
    const issues: AiIssue[] = [
      { file: 'a.ts', line: 200, severity: 'high', type: 'bug', comment: '这里存在空指针风险可能导致程序崩溃' },
    ]
    expect(closeIssueLoop(issues, check)).toHaveLength(1)
  })

  it('行号为 0 的文件级问题不参与行号邻近判定：同文件同类型 0-0 不抑制真实未修复问题的补入', () => {
    const check: AiPreviousCheck[] = [
      { file: 'a.ts', line: 0, severity: 'high', type: 'convention', comment: '配置文件版本号未按规范填写', status: 'not_fixed' },
    ]
    // 模型另报的同文件同类型文件级问题（行号均为 0，描述无关）：不得视作已上报
    const issues: AiIssue[] = [
      { file: 'a.ts', line: 0, severity: 'medium', type: 'convention', comment: '存在重复配置项应予合并' },
    ]
    const withDerived = closeIssueLoop(issues, check)
    expect(withDerived).toHaveLength(2)
    expect(withDerived.some((i) => i.comment === '配置文件版本号未按规范填写')).toBe(true)
  })
})

describe('parseReviewContent', () => {
  it('正常路径：合法 JSON 完整归一化', () => {
    const result = parseReviewContent(
      '{"summary":"总评","riskLevel":"high","issues":[{"file":"a.ts","line":3,"severity":"high","type":"bug","comment":"问题","suggestion":"修复"}]}',
      'model-x',
      2,
      '规范集',
    )
    expect(result).toMatchObject({
      summary: '总评',
      riskLevel: 'high',
      degraded: false,
      model: 'model-x',
      ruleCount: 2,
      ruleSetName: '规范集',
    })
    expect(result.issues[0]).toEqual({ file: 'a.ts', line: 3, severity: 'high', type: 'bug', comment: '问题', suggestion: '修复' })
    expect(typeof result.reviewedAt).toBe('number')
  })

  it('代码围栏与前后缀文字不阻碍解析', () => {
    const content = '好的，结果如下：\n```json\n{"summary":"s","riskLevel":"low","issues":[]}\n```\n以上。'
    expect(parseReviewContent(content, 'm', 0, 's').summary).toBe('s')
  })

  it('脏数据路径：非法枚举回退默认值，行号取整钳零，缺 comment 的条目丢弃', () => {
    const result = parseReviewContent(
      '{"summary":"","riskLevel":"critical","issues":[{"file":"a.ts","line":-5,"severity":"urgent","type":"stylee","comment":"保留"},{"file":"a.ts","line":2.7,"severity":"low","type":"bug","comment":""}]}',
      'm',
      0,
      's',
    )
    expect(result.summary).toBe('（模型未提供总评）')
    expect(result.riskLevel).toBe('medium')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ line: 0, severity: 'medium', type: 'bug' })
  })

  it('缺 file 的问题条目与 previousChecks 同口径丢弃', () => {
    const result = parseReviewContent(
      '{"summary":"s","riskLevel":"low","issues":[{"line":1,"severity":"high","type":"bug","comment":"缺 file 丢弃"},{"file":"a.ts","line":2,"severity":"low","type":"style","comment":"保留"}]}',
      'm',
      0,
      's',
    )
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].file).toBe('a.ts')
  })

  it('行号小数四舍五入；previousChecks 非法 status 回退 not_fixed', () => {
    const result = parseReviewContent(
      '{"summary":"s","riskLevel":"low","issues":[{"file":"a.ts","line":2.7,"severity":"low","type":"bug","comment":"x"}],"previousChecks":[{"file":"f","line":1,"severity":"high","type":"bug","comment":"c","status":"done","note":"n"}]}',
      'm',
      0,
      's',
    )
    expect(result.issues[0].line).toBe(3)
    expect(result.previousChecks?.[0]).toMatchObject({ status: 'not_fixed', note: 'n' })
  })

  it('无 JSON 或 JSON 损坏时抛错', () => {
    expect(() => parseReviewContent('完全没有大括号', 'm', 0, 's')).toThrow('输出中没有 JSON')
    expect(() => parseReviewContent('{not json}', 'm', 0, 's')).toThrow()
  })

  it('围栏候选被值内代码标记截断时，回退平衡扫描完成解析', () => {
    // content 值里含 ```，围栏懒匹配只捕获到前半截，整体 parse 必失败；平衡扫描跳过字符串内部取到完整对象
    const content =
      '```json\n{"summary":"s","riskLevel":"low","issues":[{"file":"a.ts","line":1,"severity":"high","type":"bug","comment":"代码里混入```围栏导致懒匹配截断"}]}\n```'
    const result = parseReviewContent(content, 'm', 0, 's')
    expect(result.summary).toBe('s')
    expect(result.issues).toHaveLength(1)
  })

  it('JSON 后附带说明文字（含大括号）时，回退平衡扫描取到完整对象', () => {
    // 无围栏 + 尾随说明含 }：extractJsonBlock 的 lastIndexOf('}') 把说明切入候选，整体 parse 失败；平衡扫描在首个闭合处截取
    const content =
      '{"summary":"s","riskLevel":"high","issues":[{"file":"b.ts","line":2,"severity":"high","type":"bug","comment":"真实问题"}]}\n以上。注意 comment 中 } 与 { 字符仅为示例说明。'
    const result = parseReviewContent(content, 'm', 0, 's')
    expect(result.summary).toBe('s')
    expect(result.riskLevel).toBe('high')
    expect(result.issues[0].file).toBe('b.ts')
  })
})

describe('parseSummaryOutput', () => {
  it('正常路径：解析 title/content 并清理标题首尾引号', () => {
    expect(parseSummaryOutput('{"title":"「命名规范」","content":"一、总述"}')).toEqual({
      title: '命名规范',
      content: '一、总述',
    })
  })

  it('代码围栏包裹的 JSON 可解析', () => {
    expect(parseSummaryOutput('```json\n{"title":"t","content":"c"}\n```')).toEqual({
      title: 't',
      content: 'c',
    })
  })

  it('脏数据路径：值中裸换行破坏 JSON 时回退逐字段提取并还原换行', () => {
    const raw = '{"title":"标题","content":"第一行\n第二行"}'
    expect(parseSummaryOutput(raw)).toEqual({ title: '标题', content: '第一行\n第二行' })
  })

  it('脏数据路径：JSON 后附带说明文字时回退提取', () => {
    expect(parseSummaryOutput('{"title":"t","content":"c"} 以上是提炼结果')).toEqual({
      title: 't',
      content: 'c',
    })
  })

  it('缺字段或完全无 JSON 时抛错', () => {
    expect(() => parseSummaryOutput('{"title":"t"}')).toThrow('AI 提炼结果缺少标题或内容')
    expect(() => parseSummaryOutput('no json here')).toThrow('AI 未返回有效的 JSON 提炼结果')
  })
})

describe('friendlyAiError', () => {
  it('常见错误按规则映射为可行动的中文提示', () => {
    expect(friendlyAiError('模型接口返回 401: Incorrect API key')).toContain('鉴权失败')
    expect(friendlyAiError('模型接口返回 403: forbidden')).toContain('无访问权限')
    expect(friendlyAiError('模型接口返回 404: not found')).toContain('Base URL')
    expect(friendlyAiError('模型接口返回 429: rate limit exceeded')).toContain('请求过于频繁')
    expect(friendlyAiError('模型接口返回 500: internal server error')).toContain('服务商内部错误')
    expect(friendlyAiError('模型接口返回 502: bad gateway')).toContain('服务商暂时不可用')
    expect(friendlyAiError('模型接口返回 503: service unavailable')).toContain('服务商暂时不可用')
    expect(friendlyAiError('模型接口返回 504: gateway timeout')).toContain('服务商暂时不可用')
    expect(friendlyAiError(new Error('ETIMEDOUT'))).toContain('请求超时')
    expect(friendlyAiError('请求失败: ECONNRESET')).toContain('网络连接失败')
    expect(friendlyAiError('模型响应中断：连续 90 秒未收到新数据')).toContain('模型响应中断')
    expect(friendlyAiError('maximum context length exceeded')).toContain('上下文长度')
  })

  it('数字状态码锚定「模型接口返回 NNN」前缀：端口号等数字子串不误判', () => {
    const portInUrl = '请求失败: https://api.test.com:5000/v1/chat/completions 请求异常'
    expect(friendlyAiError(portInUrl)).toBe(portInUrl)
    const portInId = '请求失败: request-id 127.0.0.1:4040 未知错误'
    expect(friendlyAiError(portInId)).toBe(portInId)
  })

  it('未命中规则的原样返回；Error 实例与字符串输入均支持', () => {
    const plain = '某个未知错误'
    expect(friendlyAiError(plain)).toBe(plain)
    expect(friendlyAiError(new Error(plain))).toBe(plain)
  })

  it('限流特征词收窄：具体短语命中，泛化「过多」不再误吞无关错误', () => {
    // 具体限流短语仍命中
    expect(friendlyAiError('请求过多，请稍后再试')).toContain('请求过于频繁')
    expect(friendlyAiError('该 Key 并发过多，已限流')).toContain('请求过于频繁')
    expect(friendlyAiError('配额已用尽，请充值')).toContain('请求过于频繁')
    // 与限流无关的「过多」不再误导向计费建议
    const redirect = '模型接口返回 500: 重定向次数过多'
    expect(friendlyAiError(redirect)).not.toContain('请求过于频繁')
    const tooManyOpenFiles = '打开文件数过多: EMFILE'
    expect(friendlyAiError(tooManyOpenFiles)).not.toContain('请求过于频繁')
  })
})

describe('isRetryableNetworkError', () => {
  it('锚定状态码：模型接口返回 429/500/502/503/504 可重试，404/401 不可', () => {
    expect(isRetryableNetworkError(new Error('模型接口返回 503: 服务过载'))).toBe(true)
    expect(isRetryableNetworkError(new Error('模型接口返回 500: internal server error'))).toBe(true)
    expect(isRetryableNetworkError(new Error('模型接口返回 429: quota exceeded'))).toBe(true)
    expect(isRetryableNetworkError(new Error('模型接口返回 404: not found'))).toBe(false)
    expect(isRetryableNetworkError(new Error('模型接口返回 401: unauthorized'))).toBe(false)
  })

  it('裸数字不再误判：错误消息中的端口号等同形子串不触发重试', () => {
    expect(isRetryableNetworkError(new Error('请求失败: ECONNREFUSED 127.0.0.1:5023'))).toBe(false)
    expect(isRetryableNetworkError(new Error('请求失败: https://api.test.com:5000/v1 连接异常'))).toBe(false)
  })

  it('特征词兜底：网关短语/网络错误/超时/限流仍可重试', () => {
    expect(isRetryableNetworkError(new Error('请求失败: 502 Bad Gateway'))).toBe(true)
    expect(isRetryableNetworkError(new Error('请求失败: Service Unavailable'))).toBe(true)
    expect(isRetryableNetworkError(new Error('请求失败: ECONNRESET'))).toBe(true)
    expect(
      isRetryableNetworkError(new Error('模型响应中断：连续 90 秒未收到新数据（空闲超时已到期）')),
    ).toBe(true)
    expect(isRetryableNetworkError(new Error('模型接口返回 429: too many requests'))).toBe(true)
  })
})
