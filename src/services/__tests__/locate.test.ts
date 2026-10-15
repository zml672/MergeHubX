import { describe, expect, it, vi } from 'vitest'
import { LOCATION_STATUS_META, relocateIssueAgainstContent, relocateIssues } from '../ai/locate'
import { ReviewCancelledError } from '../ai/client'
import type { AiIssue, AiIssueLocationStatus } from '../../types/ai'

function makeIssue(overrides: Partial<AiIssue> = {}): AiIssue {
  return {
    file: 'src/UserService.java',
    line: 10,
    severity: 'medium',
    type: 'bug',
    comment: '可能空指针',
    ...overrides,
  }
}

describe('relocateIssueAgainstContent', () => {
  const content = 'a\nb\nc'

  it('行号在范围内 → confirmed 且不改行号', () => {
    const issue = makeIssue({ line: 2 })
    const r = relocateIssueAgainstContent(issue, content)
    expect(r.status).toBe('confirmed')
    expect(issue.line).toBe(2)
    expect(issue.locationStatus).toBe('confirmed')
    expect(issue.originalLine).toBeUndefined()
  })

  it('行号恰为总行数（边界）→ confirmed', () => {
    const issue = makeIssue({ line: 3 })
    const r = relocateIssueAgainstContent(issue, content)
    expect(r.status).toBe('confirmed')
    expect(issue.line).toBe(3)
    expect(issue.locationStatus).toBe('confirmed')
  })

  it('行号越界 → relocated，clamp 到末行并记 originalLine', () => {
    const issue = makeIssue({ line: 99 })
    const r = relocateIssueAgainstContent(issue, content)
    expect(r.status).toBe('relocated')
    expect(issue.line).toBe(3)
    expect(issue.originalLine).toBe(99)
    expect(issue.locationStatus).toBe('relocated')
  })

  it('行号为 0 → unlocatable 且行号原样保留', () => {
    const issue = makeIssue({ line: 0 })
    const r = relocateIssueAgainstContent(issue, content)
    expect(r.status).toBe('unlocatable')
    expect(issue.locationStatus).toBe('unlocatable')
    expect(issue.line).toBe(0)
  })

  it('行号为负数 → unlocatable', () => {
    const issue = makeIssue({ line: -5 })
    const r = relocateIssueAgainstContent(issue, content)
    expect(r.status).toBe('unlocatable')
    expect(issue.locationStatus).toBe('unlocatable')
  })

  it('行号为 NaN → unlocatable', () => {
    const issue = makeIssue({ line: Number.NaN })
    const r = relocateIssueAgainstContent(issue, content)
    expect(r.status).toBe('unlocatable')
    expect(issue.locationStatus).toBe('unlocatable')
  })

  it('空文件内容（总行数 1）→ 行号 1 为 confirmed，行号 2 越界 relocated 到 1', () => {
    const ok = makeIssue({ line: 1 })
    expect(relocateIssueAgainstContent(ok, '').status).toBe('confirmed')
    const drift = makeIssue({ line: 2 })
    const r = relocateIssueAgainstContent(drift, '')
    expect(r.status).toBe('relocated')
    expect(drift.line).toBe(1)
    expect(drift.originalLine).toBe(2)
  })

  it('末尾带换行符 → 不产生空尾行，末行+1 越界而非 confirmed', () => {
    // 'a\nb\n' 是 2 行：指向第 3 行的意见不应被误判 confirmed 定位到空行
    const drift = makeIssue({ line: 3 })
    const r = relocateIssueAgainstContent(drift, 'a\nb\n')
    expect(r.status).toBe('relocated')
    expect(drift.line).toBe(2)
    expect(drift.originalLine).toBe(3)
    const ok = makeIssue({ line: 2 })
    expect(relocateIssueAgainstContent(ok, 'a\nb\n').status).toBe('confirmed')
  })

  it('非整数行号（2.5）→ unlocatable', () => {
    const issue = makeIssue({ line: 2.5 })
    const r = relocateIssueAgainstContent(issue, 'a\nb\nc')
    expect(r.status).toBe('unlocatable')
    expect(issue.locationStatus).toBe('unlocatable')
    expect(issue.line).toBe(2.5)
  })
})

describe('relocateIssues', () => {
  it('同文件多条意见共享一次取文，三态分别计数', async () => {
    const fetcher = vi.fn(async (path: string) =>
      path === 'src/A.java' ? 'l1\nl2\nl3' : 'x\ny',
    )
    const issues = [
      makeIssue({ file: 'src/A.java', line: 1 }),
      makeIssue({ file: 'src/A.java', line: 99 }),
      makeIssue({ file: 'src/B.java', line: 2 }),
    ]
    const changed = new Set(['src/A.java', 'src/B.java'])
    const stat = await relocateIssues(issues, fetcher, changed)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(stat).toEqual({ confirmed: 2, relocated: 1, unlocatable: 0 })
    expect(issues[0].locationStatus).toBe('confirmed')
    expect(issues[1].locationStatus).toBe('relocated')
    expect(issues[1].line).toBe(3)
    expect(issues[1].originalLine).toBe(99)
    expect(issues[2].locationStatus).toBe('confirmed')
  })

  it('文件不在变更白名单 → unlocatable 且不发起取文', async () => {
    const fetcher = vi.fn(async () => 'code')
    const issues = [makeIssue({ file: 'secrets/.env', line: 3 })]
    const changed = new Set(['src/A.java'])
    const stat = await relocateIssues(issues, fetcher, changed)
    expect(fetcher).not.toHaveBeenCalled()
    expect(stat.unlocatable).toBe(1)
    expect(issues[0].locationStatus).toBe('unlocatable')
    expect(issues[0].line).toBe(3)
    expect(issues[0].originalLine).toBeUndefined()
  })

  it('取文失败 → 该文件全部意见 unlocatable，统计 failedFiles，不抛错', async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path === 'src/Broken.java') throw new Error('404 not found')
      return 'l1\nl2'
    })
    const issues = [
      makeIssue({ file: 'src/Broken.java', line: 1 }),
      makeIssue({ file: 'src/Broken.java', line: 2 }),
      makeIssue({ file: 'src/Ok.java', line: 1 }),
    ]
    const stat = await relocateIssues(issues, fetcher, new Set(['src/Broken.java', 'src/Ok.java']))
    expect(stat.unlocatable).toBe(2)
    expect(stat.confirmed).toBe(1)
    expect(stat.failedFiles).toBe(1)
    expect(issues[0].locationStatus).toBe('unlocatable')
    expect(issues[1].locationStatus).toBe('unlocatable')
    expect(issues[2].locationStatus).toBe('confirmed')
  })

  it('文件超限（>160KB）→ unlocatable 且行号保持原值', async () => {
    const big = 'x'.repeat(160 * 1024 + 1)
    const fetcher = vi.fn(async () => big)
    const issues = [makeIssue({ line: 1 })]
    const stat = await relocateIssues(issues, fetcher, new Set(['src/UserService.java']))
    expect(stat.unlocatable).toBe(1)
    expect(issues[0].locationStatus).toBe('unlocatable')
    expect(issues[0].line).toBe(1)
  })

  it('用户取消 → 抛 ReviewCancelledError 冒泡（红线：禁止静默返回）', async () => {
    const fetcher = vi.fn(async () => {
      throw new ReviewCancelledError()
    })
    const cancel = { requestId: 'test', cancelled: true }
    const issues = [makeIssue()]
    await expect(
      relocateIssues(issues, fetcher, new Set(['src/UserService.java']), cancel),
    ).rejects.toThrow(ReviewCancelledError)
  })

  it('取文前置取消检查：cancelled 置位时直接抛错，不发起取文', async () => {
    const fetcher = vi.fn(async () => 'code')
    const cancel = { requestId: 'test', cancelled: true }
    const issues = [makeIssue()]
    await expect(
      relocateIssues(issues, fetcher, new Set(['src/UserService.java']), cancel),
    ).rejects.toThrow(ReviewCancelledError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('空意见列表 → 全零统计且不发起取文', async () => {
    const fetcher = vi.fn(async () => 'code')
    const stat = await relocateIssues([], fetcher, new Set(['src/A.java']))
    expect(stat).toEqual({ confirmed: 0, relocated: 0, unlocatable: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('多文件取文并发执行而非串行（并发数上限 6）', async () => {
    let inFlight = 0
    let peak = 0
    const fetcher = vi.fn(async (path: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // 微延迟让并发窗口真实重叠
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return `content of ${path}`
    })
    const files = ['a.java', 'b.java', 'c.java', 'd.java', 'e.java', 'f.java', 'g.java', 'h.java']
    const issues = files.map((f) => makeIssue({ file: f, line: 1 }))
    const stat = await relocateIssues(issues, fetcher, new Set(files))
    expect(fetcher).toHaveBeenCalledTimes(8)
    expect(stat.confirmed).toBe(8)
    // 串行时 peak 恒为 1；有界并发下 8 个文件至少出现过 2 路同时在途
    expect(peak).toBeGreaterThan(1)
  })

  it('传入共享缓存 → 取文成功回填，复核可复用；缓存命中时不重复取文', async () => {
    const fetcher = vi.fn(async () => 'l1\nl2')
    const cache = new Map<string, string>()
    const issues = [makeIssue({ file: 'src/A.java', line: 1 })]
    await relocateIssues(issues, fetcher, new Set(['src/A.java']), undefined, cache)
    expect(cache.get('src/A.java')).toBe('l1\nl2')
    // 第二次跑同文件：命中缓存，fetcher 不再被调用
    const issues2 = [makeIssue({ file: 'src/A.java', line: 2 })]
    const stat = await relocateIssues(issues2, fetcher, new Set(['src/A.java']), undefined, cache)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(stat.confirmed).toBe(1)
  })

  it('超限文件不回填缓存，且记入超限哨兵（复核阶段免二次拉取）', async () => {
    const big = 'x'.repeat(160 * 1024 + 1)
    const fetcher = vi.fn(async () => big)
    const cache = new Map<string, string>()
    const oversized = new Set<string>()
    const issues = [makeIssue({ line: 1 })]
    // 注意 makeIssue 默认 file 是 src/UserService.java，白名单须与之一致才会真实取文
    await relocateIssues(issues, fetcher, new Set(['src/UserService.java']), undefined, cache, oversized)
    expect(cache.size).toBe(0)
    expect(oversized.has('src/UserService.java')).toBe(true)
  })

  it('哨兵前置命中：入口已知超限文件不重复取文，直接 unlocatable（同轮多意见/重入场景）', async () => {
    const big = 'x'.repeat(160 * 1024 + 1)
    const oversizedFetcher = vi.fn(async () => big)
    const oversized = new Set<string>(['src/Big.java'])
    const issues = [makeIssue({ file: 'src/Big.java', line: 1 }), makeIssue({ file: 'src/Big.java', line: 2 })]
    const stat = await relocateIssues(
      issues,
      oversizedFetcher,
      new Set(['src/Big.java']),
      undefined,
      undefined,
      oversized,
    )
    expect(oversizedFetcher).not.toHaveBeenCalled()
    expect(stat.unlocatable).toBe(2)
    expect(issues.every((i) => i.locationStatus === 'unlocatable')).toBe(true)
    // 哨兵外的正常文件不受影响
    const okFetcher = vi.fn(async () => 'l1\nl2')
    const stat2 = await relocateIssues(
      [makeIssue({ file: 'src/Ok.java', line: 1 })],
      okFetcher,
      new Set(['src/Ok.java']),
      undefined,
      undefined,
      oversized,
    )
    expect(stat2.confirmed).toBe(1)
  })

  it('取文尺寸上限单源：locate 与 verify 引用同一常量（防止两阶段降级行为悄然分叉）', async () => {
    const { VERIFY_FILE_SIZE_LIMIT } = await import('../ai/verify')
    // locate.ts 不再自定义常量：同一份全文在两个阶段的「可用/超限」判定必然一致
    expect(VERIFY_FILE_SIZE_LIMIT).toBe(160 * 1024)
  })

  it('缓存条目上限：超过 64 条时淘汰最旧条目（内存有界，淘汰文件由 verify 自行取文兜底）', async () => {
    const fetcher = vi.fn(async (path: string) => `content of ${path}`)
    const cache = new Map<string, string>()
    const files = Array.from({ length: 70 }, (_, i) => `f${i}.java`)
    const issues = files.map((f) => makeIssue({ file: f, line: 1 }))
    const stat = await relocateIssues(issues, fetcher, new Set(files), undefined, cache)
    expect(stat.confirmed).toBe(70)
    expect(cache.size).toBe(64)
    // 最旧的 6 条被淘汰（f0~f5），最新的保留（f69）
    expect(cache.has('f0.java')).toBe(false)
    expect(cache.has('f5.java')).toBe(false)
    expect(cache.has('f6.java')).toBe(true)
    expect(cache.has('f69.java')).toBe(true)
  })

  it('命中已淘汰条目的路径正确性：缓存满后同文件第二次评审仍能取文完成校验', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      return 'l1\nl2'
    })
    const cache = new Map<string, string>()
    // 第一轮：灌满 64 条占满缓存（灌入不触发淘汰，size 0→64）
    const fillerA = Array.from({ length: 64 }, (_, i) => `fillerA${i}.java`)
    await relocateIssues(
      fillerA.map((f) => makeIssue({ file: f, line: 1 })),
      vi.fn(async () => 'x'),
      new Set(fillerA),
      undefined,
      cache,
    )
    // target 第一次评审：缓存未命中取文回填（cachePut 淘汰最旧的 fillerA0），target 为最新条目
    const first = [makeIssue({ file: 'target.java', line: 2 })]
    await relocateIssues(first, fetcher, new Set(['target.java']), undefined, cache)
    expect(first[0].locationStatus).toBe('confirmed')
    expect(calls).toBe(1)
    expect(cache.has('target.java')).toBe(true)
    // 再灌 64 条把 target 挤出：cachePut 按插入序淘汰最旧，target 随灌入逐渐变最旧被删
    const fillerB = Array.from({ length: 64 }, (_, i) => `fillerB${i}.java`)
    await relocateIssues(
      fillerB.map((f) => makeIssue({ file: f, line: 1 })),
      vi.fn(async () => 'x'),
      new Set(fillerB),
      undefined,
      cache,
    )
    expect(cache.has('target.java')).toBe(false)
    // 第二轮：同文件再次评审 → 缓存未命中 → fetcher 第二次被调用，结论仍正确（淘汰不损正确性）
    const second = [makeIssue({ file: 'target.java', line: 1 })]
    await relocateIssues(second, fetcher, new Set(['target.java']), undefined, cache)
    expect(calls).toBe(2)
    expect(second[0].locationStatus).toBe('confirmed')
  })
})

describe('LOCATION_STATUS_META（展示元数据唯一口径）', () => {
  it('三态齐全且字段完整：label/color/badge/tooltip 均非空，confirmed 不出徽标', () => {
    const statuses: AiIssueLocationStatus[] = ['confirmed', 'relocated', 'unlocatable']
    for (const s of statuses) {
      const meta = LOCATION_STATUS_META[s]
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.color.length).toBeGreaterThan(0)
      expect(typeof meta.badge).toBe('boolean')
      expect(typeof meta.tooltip).toBe('function')
    }
    // 常态多数派不出徽标（防满屏绿标噪音），异常态必出
    expect(LOCATION_STATUS_META.confirmed.badge).toBe(false)
    expect(LOCATION_STATUS_META.relocated.badge).toBe(true)
    expect(LOCATION_STATUS_META.unlocatable.badge).toBe(true)
  })

  it('tooltip 随意见动态生成：relocated 读 originalLine，旧数据缺字段有兜底', () => {
    const withOriginal = LOCATION_STATUS_META.relocated.tooltip(
      makeIssue({ line: 3, originalLine: 99, locationStatus: 'relocated' }),
    )
    expect(withOriginal).toContain('99')
    // 旧持久化数据可能没有 originalLine，tooltip 不得崩、退化为通用文案
    const withoutOriginal = LOCATION_STATUS_META.relocated.tooltip(makeIssue({ line: 3 }))
    expect(withoutOriginal.length).toBeGreaterThan(0)
    expect(withoutOriginal).not.toBe(withOriginal)
  })

  it('文案与实现同源：relocated tooltip 描述的修正策略与 relocateIssueAgainstContent 实际行为一致', () => {
    // 实现侧事实：越界 clamp 到文件末行（3 行文件的末行是 3）
    const issue = makeIssue({ line: 99 })
    relocateIssueAgainstContent(issue, 'a\nb\nc')
    expect(issue.line).toBe(3)
    expect(issue.originalLine).toBe(99)
    expect(issue.locationStatus).toBe('relocated')
    // 展示侧文案必须覆盖这一事实的关键词
    const tip = LOCATION_STATUS_META.relocated.tooltip(issue)
    expect(tip).toContain('99')
    expect(tip).toContain('文件末行')
  })
})
