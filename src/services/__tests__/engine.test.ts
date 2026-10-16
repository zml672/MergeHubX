// @vitest-environment node
// reviewPullRequest 的请求日志纪律：请求块与真实发生的模型调用一一对应——
// 失败中断后未发起的批次、断点续跑命中的批次都不得预写请求日志
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filterExemptedIssues, reviewPullRequest } from '../ai/engine'
import { logAiRequest } from '../aiDebugLog'
import { chatCompletionStream } from '../ai/client'
import { issueFingerprints } from '../../utils/issueFingerprint'
import type { AiReviewEvent } from '../ai/engine'
import type { AiIssue, AiModelConfig, GovernanceRecord, ReviewRule } from '../../types/ai'
import type { DiffFile, PullRequestDetail } from '../../types/platform'

vi.mock('../aiDebugLog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logAiRequest: vi.fn(),
}))
vi.mock('../ai/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletionStream: vi.fn(),
}))

const config: AiModelConfig = {
  baseUrl: 'https://api.test.com/v1',
  model: 'model-x',
  apiKey: 'k',
  concurrency: 1,
}
const rules: ReviewRule[] = []

/** 两个各 25KB 无换行 patch 的文件：确定性切成每文件 4 块、共 4 个批次 */
function makeTwoFilePr(): PullRequestDetail {
  const files: DiffFile[] = [
    { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x'.repeat(25 * 1024) },
    { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y'.repeat(25 * 1024) },
  ]
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

const okResult = {
  content: '{"summary":"s","riskLevel":"low","issues":[]}',
  answerChars: 1,
  reasoningChars: 0,
  usage: undefined,
}

beforeEach(() => {
  vi.mocked(logAiRequest).mockClear()
  vi.mocked(chatCompletionStream).mockReset()
})

describe('reviewPullRequest 请求日志纪律', () => {
  it('首批不可重试失败后，未发起批次的请求日志不再预写', async () => {
    vi.mocked(chatCompletionStream).mockRejectedValueOnce(new Error('模型接口返回 404: not found'))
    await expect(reviewPullRequest(config, makeTwoFilePr(), { rules, ruleSetName: 's' })).rejects.toThrow(
      '模型接口返回 404',
    )
    // 只有真正发起调用的第 1 批写了请求日志；2~4 批从未发起，不应留下记录
    expect(logAiRequest).toHaveBeenCalledTimes(1)
  })

  it('正常完成：每个实际调用的批次恰好对应一条请求日志', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const events: AiReviewEvent[] = []
    await reviewPullRequest(
      config,
      {
        ...makeTwoFilePr(),
        files: [
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
          { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y' },
        ],
      },
      { rules, ruleSetName: 's', onEvent: (e) => events.push(e) },
    )
    // 小 patch 单批完成：一条请求日志对应唯一一次模型调用（无总评合成调用）
    expect(logAiRequest).toHaveBeenCalledTimes(1)
    expect(chatCompletionStream).toHaveBeenCalledTimes(1)
  })

  it('batchDone 事件必须携带批次结果（断点存档的数据源）', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const events: AiReviewEvent[] = []
    await reviewPullRequest(
      config,
      {
        ...makeTwoFilePr(),
        files: [
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
          { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y' },
        ],
      },
      { rules, ruleSetName: 's', onEvent: (e) => events.push(e) },
    )
    const batchDones = events.filter((e) => e.type === 'batchDone')
    expect(batchDones.length).toBeGreaterThan(0)
    for (const event of batchDones) {
      // 断点存档的数据源：缺失该字段会导致断点永远为空、失败后无法续跑
      expect(event.result).toBeDefined()
      expect(event.result?.summary).toBe('s')
    }
  })

  it('断点续跑：命中的批次不写请求日志，仅实际重跑的批次记录', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const resumed = {
      summary: 's',
      riskLevel: 'low' as const,
      issues: [],
      degraded: false,
      reviewedAt: 1,
      model: 'model-x',
      ruleCount: 0,
    }
    await reviewPullRequest(config, makeTwoFilePr(), {
      rules,
      ruleSetName: 's',
      completed: new Map([
        [1, resumed],
        [2, resumed],
      ]),
    })
    // 批次 1~2 命中断点被跳过，仅第 3 批真正调用模型
    expect(logAiRequest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logAiRequest).mock.calls[0][0]).toBe('AI 评审（第 3/3 批）')
  })

  it('断点续跑口径：batchStart 与 done 的 sentChars 同样排除命中断点的批次', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue(okResult)
    const resumed = {
      summary: 's',
      riskLevel: 'low' as const,
      issues: [],
      degraded: false,
      reviewedAt: 1,
      model: 'model-x',
      ruleCount: 0,
    }
    const events: AiReviewEvent[] = []
    await reviewPullRequest(config, makeTwoFilePr(), {
      rules,
      ruleSetName: 's',
      onEvent: (e) => events.push(e),
      completed: new Map([
        [1, resumed],
        [2, resumed],
      ]),
    })
    // 4 批中 1~2 批续跑命中：batchStart 仅第 3 批发出，其 sentChars 只含第 3 批提示词
    // （不把被跳过的 1~2 批前缀计入），与 done 事件排除口径一致
    const starts = events.filter((e) => e.type === 'batchStart')
    expect(starts).toHaveLength(1)
    const done = events.find((e) => e.type === 'done')
    const batch3Sent = done?.sentChars ?? 0
    expect(starts[0].sentChars).toBe(batch3Sent)
    expect(batch3Sent).toBeGreaterThan(0)
  })
})

/** P1-15② 引擎层豁免前置拦截：filterExemptedIssues 纯函数行为 + reviewPullRequest 端到端接线 */
describe('filterExemptedIssues 豁免前置拦截', () => {
  let seq = 0
  const issue = (overrides: Partial<AiIssue>): AiIssue => ({
    file: 'src/a.ts',
    line: 3,
    severity: 'medium',
    type: 'bug',
    comment: `问题 ${seq += 1}`,
    ...overrides,
  })
  const emptyResult = () => ({
    summary: 's',
    riskLevel: 'low' as const,
    issues: [] as AiIssue[],
    degraded: false,
    reviewedAt: 1,
    model: 'model-x',
    ruleCount: 0,
  })
  const recordOf = (issueData: AiIssue, extra?: Partial<GovernanceRecord>): GovernanceRecord => {
    const { exact, loose } = issueFingerprints(issueData)
    return {
      id: `r-${seq += 1}`,
      fingerprint: exact,
      looseFingerprint: loose,
      scope: 'general',
      disposition: 'exempt',
      file: issueData.file,
      line: issueData.line,
      type: issueData.type,
      comment: issueData.comment,
      recordedAt: 1,
      ...extra,
    }
  }

  it('精确指纹命中：描述完全一致的问题被移出，其余保留', () => {
    const hit = issue({ file: 'src/a.ts', line: 3, comment: '空指针风险' })
    const keep = issue({ file: 'src/a.ts', line: 10, comment: '另一问题' })
    const exempt = [recordOf(hit)]
    const removed = filterExemptedIssues(
      [{ ...emptyResult(), issues: [hit, keep] }],
      exempt,
    )
    expect(removed).toEqual([hit])
  })

  it('精确键单独命中：描述一致但类型被模型重归类（宽松键失配）仍拦截', () => {
    // 记录时 type=bug；重报时模型把同一问题归为 convention——宽松键（文件|类型|桶）失配，
    // 只能靠精确指纹（文件|描述）命中，这条用例单独守护 exactKeys 匹配分支
    const original = issue({ file: 'src/a.ts', line: 3, type: 'bug', comment: '同一句话' })
    const exempt = [recordOf(original)]
    const retype = issue({ file: 'src/a.ts', line: 3, type: 'convention', comment: '同一句话' })
    const removed = filterExemptedIssues([{ ...emptyResult(), issues: [retype] }], exempt)
    expect(removed).toEqual([retype])
  })

  it('宽松指纹命中：措辞漂移重报（同文件同类型同桶）也被拦截', () => {
    const original = issue({ file: 'src/a.ts', line: 3, type: 'bug', comment: '原始描述' })
    const reworded = issue({ file: 'src/a.ts', line: 4, type: 'bug', comment: '完全不同的说法' })
    const exempt = [recordOf(original)]
    const removed = filterExemptedIssues([{ ...emptyResult(), issues: [reworded] }], exempt)
    // 行 3 与行 4 同属桶 0，宽松键相同即命中——描述文本不参与宽松匹配
    expect(removed).toEqual([reworded])
  })

  it('宽松键不同的记录（旧数据缺省）只走精确匹配', () => {
    const original = issue({ comment: '原始描述' })
    const exempt = [recordOf(original, { looseFingerprint: undefined })]
    const reworded = issue({ line: 4, comment: '完全不同的说法' })
    // 同桶同类型但措辞漂移：精确失配、记录无宽松键 → 不拦（宁漏拦不误拦）
    const removed = filterExemptedIssues([{ ...emptyResult(), issues: [reworded] }], exempt)
    expect(removed).toEqual([])
  })

  it('不同文件/不同类型/不同桶不误拦', () => {
    const hit = issue({ file: 'src/a.ts', line: 3, type: 'bug' })
    const exempt = [recordOf(hit)]
    const survivors = [
      issue({ file: 'src/b.ts', line: 3, type: 'bug', comment: '异文件' }),
      issue({ file: 'src/a.ts', line: 3, type: 'style', comment: '异类型' }),
      issue({ file: 'src/a.ts', line: 8, type: 'bug', comment: '异桶（行 8 属桶 1）' }),
    ]
    const removed = filterExemptedIssues([{ ...emptyResult(), issues: survivors }], exempt)
    expect(removed).toEqual([])
  })

  it('脏行号（0）归哨兵桶，不与真实行 1~5 的豁免记录互撞', () => {
    const real = issue({ file: 'src/a.ts', line: 3, type: 'bug' })
    const exempt = [recordOf(real)]
    const dirty = issue({ file: 'src/a.ts', line: 0, type: 'bug', comment: '文件级结论' })
    const removed = filterExemptedIssues([{ ...emptyResult(), issues: [dirty] }], exempt)
    // 行 0 → 哨兵桶 -1，与行 3 的桶 0 隔离，不得误拦
    expect(removed).toEqual([])
  })

  it('跨批重复上报同一问题只计一条，且评级取更严重者', () => {
    const hitA = issue({ file: 'src/a.ts', line: 3, type: 'bug', severity: 'low' })
    const exempt = [recordOf(hitA)]
    const batch1 = { ...emptyResult(), issues: [hitA] }
    const batch2 = { ...emptyResult(), issues: [{ ...hitA, severity: 'high' as const }] }
    const removed = filterExemptedIssues([batch1, batch2], exempt)
    expect(removed).toHaveLength(1)
    // 去重取更严重评级（跨批合并口径）
    expect(removed[0].severity).toBe('high')
  })

  it('多条移除项按 severity/file/line 完整排序', () => {
    // 输入顺序刻意与期望顺序完全相反，同级排序逐级验证：
    // severity 分层（high→medium→low）→ 同级 file 字典序 → 同文件 line 升序
    const items = [
      issue({ file: 'src/b.ts', line: 9, type: 'bug', severity: 'low', comment: 'L-low' }),
      issue({ file: 'src/b.ts', line: 2, type: 'style', severity: 'medium', comment: 'B-med' }),
      issue({ file: 'src/a.ts', line: 15, type: 'bug', severity: 'medium', comment: 'A-med15' }),
      issue({ file: 'src/a.ts', line: 3, type: 'bug', severity: 'high', comment: 'A-high' }),
    ]
    const exempt = items.map((i) => recordOf(i))
    const removed = filterExemptedIssues([{ ...emptyResult(), issues: items }], exempt)
    // 完整对象顺序断言：排序 + 内容 + 不多不少
    expect(removed).toEqual([items[3], items[2], items[1], items[0]])
  })

  it('exempt 为空数组时早退返回空，不触碰任何结果', () => {
    const issues = [issue({})]
    const batch = { ...emptyResult(), issues }
    expect(filterExemptedIssues([batch], [])).toEqual([])
    // 早退不得有副作用：原结果保持不变
    expect(batch.issues).toBe(issues)
    expect(batch.issues).toHaveLength(1)
  })
})

/** P1-15② 端到端：批次模型输出含命中问题与存活问题，断言拦截后清单、exempted 统计与事件流 */
describe('reviewPullRequest 豁免前置拦截接线', () => {
  const hit = {
    file: 'src/a.ts',
    line: 3,
    severity: 'low',
    type: 'bug' as const,
    comment: '豁免库已知问题',
  }
  const keep = {
    file: 'src/b.ts',
    line: 7,
    severity: 'high',
    type: 'security',
    comment: '真实新问题',
  }
  const batchContent = JSON.stringify({
    summary: 's',
    riskLevel: 'high',
    issues: [hit, keep],
  })

  it('命中意见被移出清单、不进复核，exemptDone 事件与 exempted 统计齐备', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({ ...okResult, content: batchContent })
    const { exact, loose } = issueFingerprints(hit as AiIssue)
    const exempt: GovernanceRecord[] = [
      {
        id: 'r-1',
        fingerprint: exact,
        looseFingerprint: loose,
        scope: 'general',
        disposition: 'exempt',
        file: hit.file,
        line: hit.line,
        type: hit.type,
        comment: hit.comment,
        recordedAt: 1,
      },
    ]
    const events: AiReviewEvent[] = []
    const result = await reviewPullRequest(config, {
      ...makeTwoFilePr(),
      files: [
        { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y' },
      ],
    }, { rules, ruleSetName: 's', onEvent: (e) => events.push(e), exempt })
    // 清单只剩未命中项；被拦截项移入 exempted 统计
    expect(result.issues.map((i) => i.comment)).toEqual(['真实新问题'])
    expect(result.exempted?.count).toBe(1)
    expect(result.exempted?.issues.map((i) => i.comment)).toEqual(['豁免库已知问题'])
    // 事件流：exemptDone 发出且计数正确
    const exemptDone = events.find((e) => e.type === 'exemptDone')
    expect(exemptDone).toBeDefined()
    expect(exemptDone?.count).toBe(1)
  })

  it('无命中时不发 exemptDone 事件、不挂 exempted 统计', async () => {
    vi.mocked(chatCompletionStream).mockResolvedValue({ ...okResult, content: batchContent })
    const events: AiReviewEvent[] = []
    const result = await reviewPullRequest(config, {
      ...makeTwoFilePr(),
      files: [
        { path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'x' },
        { path: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: 'y' },
      ],
    }, { rules, ruleSetName: 's', onEvent: (e) => events.push(e) })
    expect(result.issues).toHaveLength(2)
    expect(result.exempted).toBeUndefined()
    expect(events.some((e) => e.type === 'exemptDone')).toBe(false)
  })
})
