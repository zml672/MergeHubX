// @vitest-environment node
// 三平台评论 API 封装（R2）：请求 URL/方法/鉴权头/响应解析逐平台钉死，幂等 upsert 分支全覆盖；
// 翻页/护栏/截断信号/created_at 排序兜底逐平台验证（评审 #32/#34/#41/#42）
// 注：三平台用例不抽公共工厂（评审 #37 未采纳）——条数驱动 vs 头驱动的翻页机制本质不同，
// 显式钉死平台差异正是本文件的职责，工厂化会把差异藏进参数回调
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { githubProvider } from '../platforms/github'
import { gitlabProvider } from '../platforms/gitlab'
import { giteeProvider } from '../platforms/gitee'
import { httpRequest } from '../http'
import type { PlatformAccount } from '../../types/platform'

vi.mock('../http', () => ({ httpRequest: vi.fn() }))

const account: PlatformAccount = { platform: 'github', token: 'tk', baseUrl: '' }

function ok(body: unknown): { status: number; headers: Record<string, string>; body: string } {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

beforeEach(() => {
  vi.mocked(httpRequest).mockReset()
  vi.mocked(httpRequest).mockResolvedValue(ok([]))
})

// 统一恢复 spy（评审 #38）：用例内手动 mockRestore 在断言失败时不执行，
// 被 mock 的 console.warn 会泄漏到后续用例干扰告警断言
afterEach(() => {
  vi.restoreAllMocks()
})

describe('github 评论 API', () => {
  it('list：GET issue comments 端点，Bearer 鉴权，解析 id/body/createdAt；单页即止', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      ok([
        { id: 11, body: 'a', created_at: '2026-01-01T00:00:02Z' },
        { id: 22, body: 'b', created_at: '2026-01-01T00:00:01Z' },
      ]),
    )
    const { comments, truncated } = await githubProvider.listPullRequestComments(account, 'acme/app', 12)
    // created_at 升序排序兜底（评审 #41）：不赌平台默认顺序，按时间戳归一
    expect(comments).toEqual([
      { id: 22, body: 'b', createdAt: Date.parse('2026-01-01T00:00:01Z') },
      { id: 11, body: 'a', createdAt: Date.parse('2026-01-01T00:00:02Z') },
    ])
    expect(truncated).toBe(false)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    // sort/direction 显式固定升序（评审 #47）：truncated 语义不赌平台默认排序
    expect(req.url).toBe(
      'https://api.github.com/repos/acme/app/issues/12/comments?per_page=100&sort=created&direction=asc&page=1',
    )
    expect(req.method).toBeUndefined()
    expect(req.headers?.Authorization).toBe('Bearer tk')
    expect(vi.mocked(httpRequest).mock.calls).toHaveLength(1)
  })

  it('list 排序兜底：非法 created_at（解析失败）不进比较器，视作最旧排最前（评审 #48）', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      ok([
        { id: 1, body: '正常较晚', created_at: '2026-01-01T00:00:02Z' },
        { id: 2, body: '非法时间（在中间，NaN 若进比较器会把后续正常项挤乱序）', created_at: 'not-a-date' },
        { id: 3, body: '正常较早', created_at: '2026-01-01T00:00:01Z' },
        { id: 4, body: '缺时间戳' },
      ]),
    )
    const { comments } = await githubProvider.listPullRequestComments(account, 'acme/app', 12)
    // 非法时间戳归一为 undefined → 与缺失同待、视作最旧排最前（两者间按稳定排序保持原位 2→4）
    expect(comments.map((c) => c.id)).toEqual([2, 4, 3, 1])
  })

  it('list 翻页：满 100 条继续拉下一页，不满即止（评审 #32）', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `c${i}`,
      created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    }))
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok(full))
      .mockResolvedValueOnce(ok([{ id: 999, body: 'tail', created_at: '2026-02-01T00:00:00Z' }]))
    const { comments, truncated } = await githubProvider.listPullRequestComments(account, 'acme/app', 12)
    expect(comments).toHaveLength(101)
    expect(comments[100]?.id).toBe(999)
    expect(comments[100]?.body).toBe('tail')
    expect(truncated).toBe(false)
    expect(vi.mocked(httpRequest).mock.calls[1][0].url).toBe(
      'https://api.github.com/repos/acme/app/issues/12/comments?per_page=100&sort=created&direction=asc&page=2',
    )
    expect(vi.mocked(httpRequest).mock.calls).toHaveLength(2)
  })

  it('list 正常收尾（末页不满 100）：不告警、truncated=false（评审 #34/#42）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` }))
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok(full))
      .mockResolvedValueOnce(ok([{ id: 999, body: 'tail' }]))
    const normal = await githubProvider.listPullRequestComments(account, 'acme/app', 12)
    expect(normal.truncated).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('list 翻页护栏触发（末页仍满页）：告警截断 + truncated 标记（评审 #34/#42）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` }))
    // 护栏路径：每页都满 100 条，20 页耗尽后循环退出 → warn + truncated=true
    vi.mocked(httpRequest).mockResolvedValue(ok(full))
    const { truncated } = await githubProvider.listPullRequestComments(account, 'acme/app', 12)
    expect(truncated).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('[github] acme/app#12')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('2000')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('截断')
  })

  it('list 失败：非 2xx 抛出含平台名与状态码的错误（评审 #39）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 500, headers: {}, body: '{"message":"boom"}' })
    await expect(githubProvider.listPullRequestComments(account, 'acme/app', 12)).rejects.toThrow(
      'GitHub API 500',
    )
  })

  it('list 2xx 但响应体非 JSON：抛出带平台与端点上下文的业务错误（评审 #50）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 200, headers: {}, body: '<html>502 Bad Gateway</html>' })
    await expect(githubProvider.listPullRequestComments(account, 'acme/app', 12)).rejects.toThrow(
      /GitHub API 返回了非 JSON 响应.*issues\/12\/comments.*<html>/,
    )
  })

  it('自定义 baseUrl 生效：list URL 拼接（评审 #54：自建 GitHub Enterprise 场景）', async () => {
    const acct: PlatformAccount = { platform: 'github', token: 'tk', baseUrl: 'https://github.example.com/' }
    vi.mocked(httpRequest).mockResolvedValue(ok([]))
    const { comments } = await githubProvider.listPullRequestComments(acct, 'acme/app', 12)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe(
      'https://github.example.com/repos/acme/app/issues/12/comments?per_page=100&sort=created&direction=asc&page=1',
    )
    expect(comments).toEqual([])
  })

  it('自定义 baseUrl 生效：upsert POST URL 拼接（评审 #54）', async () => {
    const acct: PlatformAccount = { platform: 'github', token: 'tk', baseUrl: 'https://github.example.com/' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 99 }))
    await githubProvider.upsertPullRequestComment(acct, 'acme/app', 12, null, '正文')
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe('https://github.example.com/repos/acme/app/issues/12/comments')
    expect(req.method).toBe('POST')
  })

  it('upsert 发布：POST issue comments，返回新评论 id', async () => {
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 99 }))
    const id = await githubProvider.upsertPullRequestComment(account, 'acme/app', 12, null, '正文')
    expect(id).toBe(99)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe('https://api.github.com/repos/acme/app/issues/12/comments')
    expect(req.method).toBe('POST')
    expect(JSON.parse(req.body ?? '{}')).toEqual({ body: '正文' })
  })

  it('upsert 更新：PATCH issues/comments/{id} 原帖编辑', async () => {
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 99 }))
    const id = await githubProvider.upsertPullRequestComment(account, 'acme/app', 12, 99, '新正文')
    expect(id).toBe(99)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe('https://api.github.com/repos/acme/app/issues/comments/99')
    expect(req.method).toBe('PATCH')
  })

  it('失败：非 2xx 抛出含平台名与状态码的错误', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 403, headers: {}, body: '{"message":"forbidden"}' })
    await expect(
      githubProvider.upsertPullRequestComment(account, 'acme/app', 12, null, 'x'),
    ).rejects.toThrow('GitHub API 403')
  })

  it('detail：PR 详情端点 2xx 但响应体非 JSON，抛带端点上下文的错误（族 A 收口回归）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 200, headers: {}, body: '<html>WAF 拦截页</html>' })
    await expect(githubProvider.getPullRequestDetail(account, 'acme/app', 12)).rejects.toThrow(
      /GitHub API 返回了非 JSON 响应.*pulls\/12 详情.*<html>/,
    )
  })

  it('detail：文件列表端点 2xx 但响应体非 JSON，抛带页码上下文的错误（族 A 收口回归）', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok({ number: 12, changed_files: 1 }))
      .mockResolvedValueOnce({ status: 200, headers: {}, body: 'gateway timeout' })
    await expect(githubProvider.getPullRequestDetail(account, 'acme/app', 12)).rejects.toThrow(
      /GitHub API 返回了非 JSON 响应.*pulls\/12\/files 第 1 页.*gateway timeout/,
    )
  })

  it('detail：文件列表翻页达护栏上限（末页仍满 100）告警截断（族 B 收口回归）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` }))
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(
        ok({
          number: 12,
          changed_files: 5000, // 与实际不符也触发第二告警
          base: { repo: { full_name: 'acme/app' }, ref: 'main' },
          head: { ref: 'feat' },
          user: { login: 'alice' },
          title: 't',
          state: 'open',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/acme/app/pull/12',
        }),
      )
      .mockResolvedValue(ok(fullPage)) // 每页都满 100 → 30 页耗尽
    const detail = await githubProvider.getPullRequestDetail(account, 'acme/app', 12)
    expect(detail.files).toHaveLength(3000)
    const truncWarn = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('文件列表翻页达护栏'))
    expect(truncWarn).toBeDefined()
    expect(truncWarn).toContain('[github] acme/app#12')
    expect(truncWarn).toContain('3000')
  })
})

describe('gitlab 评论 API', () => {
  it('list：notes 端点 + PRIVATE-TOKEN，按 system!==true 过滤系统注记（评审 #26）；单页即止', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      ok([
        { id: 1, body: '普通评论', system: false, type: null, created_at: '2026-01-01T00:00:02Z' },
        { id: 2, body: 'assigned to @bob', system: true, type: null, created_at: '2026-01-01T00:00:03Z' },
        { id: 3, body: '行内评论', system: false, type: 'DiffNote', created_at: '2026-01-01T00:00:01Z' },
        { id: 4, body: 'approved', system: true, type: null, created_at: '2026-01-01T00:00:04Z' },
        { id: 5, body: '讨论串回复', system: false, type: 'DiscussionNote', created_at: '2026-01-01T00:00:00Z' },
      ]),
    )
    const { comments, truncated } = await gitlabProvider.listPullRequestComments(
      { platform: 'gitlab', token: 'tk', baseUrl: '' },
      'group/sub/app',
      7,
    )
    // 系统注记（system:true）滤除；DiffNote/DiscussionNote/type:null 的用户评论全保留；
    // created_at 升序排序兜底（评审 #41）
    expect(comments).toEqual([
      { id: 5, body: '讨论串回复', createdAt: Date.parse('2026-01-01T00:00:00Z') },
      { id: 3, body: '行内评论', createdAt: Date.parse('2026-01-01T00:00:01Z') },
      { id: 1, body: '普通评论', createdAt: Date.parse('2026-01-01T00:00:02Z') },
    ])
    expect(truncated).toBe(false)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe(
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests/7/notes?per_page=100&sort=asc&order_by=created_at',
    )
    expect(req.headers?.['PRIVATE-TOKEN']).toBe('tk')
    expect(vi.mocked(httpRequest).mock.calls).toHaveLength(1)
  })

  it('list 翻页：X-Next-Page 头驱动下一页，头缺失即止（评审 #32）', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-next-page': '2' },
        body: JSON.stringify([{ id: 1, body: '第一页末尾', system: false, created_at: '2026-01-01T00:00:00Z' }]),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify([{ id: 2, body: '第二页最新', system: false, created_at: '2026-01-02T00:00:00Z' }]),
      })
    const { comments, truncated } = await gitlabProvider.listPullRequestComments(
      { platform: 'gitlab', token: 'tk', baseUrl: '' },
      'g/app',
      7,
    )
    expect(comments.map((c) => c.id)).toEqual([1, 2])
    expect(truncated).toBe(false)
    expect(vi.mocked(httpRequest).mock.calls[1][0].url).toBe(
      'https://gitlab.com/api/v4/projects/g%2Fapp/merge_requests/7/notes?per_page=100&sort=asc&order_by=created_at&page=2',
    )
    expect(vi.mocked(httpRequest).mock.calls).toHaveLength(2)
  })

  it('list 正常收尾（末页无下一页头）：不告警、truncated=false（评审 #34/#42）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(httpRequest)
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-next-page': '2' },
        body: JSON.stringify([{ id: 1, body: '第一页', system: false }]),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify([{ id: 2, body: '第二页', system: false }]),
      })
    const normal = await gitlabProvider.listPullRequestComments(
      { platform: 'gitlab', token: 'tk', baseUrl: '' },
      'g/app',
      7,
    )
    expect(normal.truncated).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('list 翻页护栏触发（耗尽 20 页仍有下一页头）：告警截断 + truncated 标记（评审 #34/#42）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 护栏路径：每页都带 x-next-page，20 页耗尽后循环退出（仍有下一页头）→ warn + truncated
    vi.mocked(httpRequest).mockResolvedValue({
      status: 200,
      headers: { 'x-next-page': '99' },
      body: JSON.stringify(
        Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'c', system: false })),
      ),
    })
    const { truncated } = await gitlabProvider.listPullRequestComments(
      { platform: 'gitlab', token: 'tk', baseUrl: '' },
      'g/app',
      7,
    )
    expect(truncated).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('[gitlab] g/app#7')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('2000')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('截断')
  })

  it('list 失败：非 2xx 抛出含平台名与状态码的错误（评审 #39）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 401, headers: {}, body: '{"message":"unauthorized"}' })
    await expect(
      gitlabProvider.listPullRequestComments(
        { platform: 'gitlab', token: 'tk', baseUrl: '' },
        'g/app',
        7,
      ),
    ).rejects.toThrow('GitLab API 401')
  })

  it('list 2xx 但响应体非 JSON：抛出带平台与端点上下文的业务错误（评审 #50）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      status: 200,
      headers: {},
      body: '<!DOCTYPE html><html><body>proxy error</body></html>',
    })
    await expect(
      gitlabProvider.listPullRequestComments(
        { platform: 'gitlab', token: 'tk', baseUrl: '' },
        'g/app',
        7,
      ),
    ).rejects.toThrow(/GitLab API 返回了非 JSON 响应.*<!DOCTYPE html>/)
  })

  it('upsert 发布：null 走 POST notes（评审 #51：发布/更新拆分独立 it；#53 补 body 断言）', async () => {
    const acct: PlatformAccount = { platform: 'gitlab', token: 'tk', baseUrl: '' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 5 }))
    await gitlabProvider.upsertPullRequestComment(acct, 'g/app', 7, null, '正文')
    const post = vi.mocked(httpRequest).mock.calls[0][0]
    expect(post.url).toBe('https://gitlab.com/api/v4/projects/g%2Fapp/merge_requests/7/notes')
    expect(post.method).toBe('POST')
    expect(JSON.parse(post.body ?? '{}')).toEqual({ body: '正文' })
  })

  it('upsert 更新：非 null 走 PUT notes/{id}，新正文随请求发出（评审 #53）', async () => {
    const acct: PlatformAccount = { platform: 'gitlab', token: 'tk', baseUrl: '' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 5 }))
    await gitlabProvider.upsertPullRequestComment(acct, 'g/app', 7, 5, '新正文')
    const put = vi.mocked(httpRequest).mock.calls[0][0]
    expect(put.url).toBe('https://gitlab.com/api/v4/projects/g%2Fapp/merge_requests/7/notes/5')
    expect(put.method).toBe('PUT')
    expect(JSON.parse(put.body ?? '{}')).toEqual({ body: '新正文' })
  })

  it('自定义 baseUrl 生效：list URL 拼接（评审 #54：自建实例与 Gitee 对齐补覆盖）', async () => {
    const acct: PlatformAccount = { platform: 'gitlab', token: 'tk', baseUrl: 'https://gitlab.example.com/' }
    vi.mocked(httpRequest).mockResolvedValue(ok([]))
    const { comments } = await gitlabProvider.listPullRequestComments(acct, 'g/app', 7)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe(
      'https://gitlab.example.com/api/v4/projects/g%2Fapp/merge_requests/7/notes?per_page=100&sort=asc&order_by=created_at',
    )
    expect(comments).toEqual([])
  })

  it('自定义 baseUrl 生效：upsert POST URL 拼接（评审 #54）', async () => {
    const acct: PlatformAccount = { platform: 'gitlab', token: 'tk', baseUrl: 'https://gitlab.example.com/' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 5 }))
    await gitlabProvider.upsertPullRequestComment(acct, 'g/app', 7, null, '正文')
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe('https://gitlab.example.com/api/v4/projects/g%2Fapp/merge_requests/7/notes')
    expect(req.method).toBe('POST')
  })

  it('detail：MR 详情端点 2xx 但响应体非 JSON，抛带端点上下文的错误（族 A 收口回归）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 200, headers: {}, body: '<html>登录页</html>' })
    await expect(
      gitlabProvider.getPullRequestDetail({ platform: 'gitlab', token: 'tk', baseUrl: '' }, 'g/app', 7),
    ).rejects.toThrow(/GitLab API 返回了非 JSON 响应.*merge_requests\/7 详情.*<html>/)
  })

  it('detail：diff 回退链全部非 JSON 时聚合报错而非裸 SyntaxError（族 A 收口回归）', async () => {
    const acct: PlatformAccount = { platform: 'gitlab', token: 'tk', baseUrl: '' }
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok({ iid: 7, title: 't', state: 'opened' })) // MR 详情
      .mockResolvedValue({ status: 200, headers: {}, body: '<html>WAF</html>' }) // diff 三端点全部非 JSON
    await expect(gitlabProvider.getPullRequestDetail(acct, 'g/app', 7)).rejects.toThrow(
      /获取 MR diff 失败.*已依次尝试/,
    )
  })

  it('detail：diff 翻页达护栏上限（耗尽 10 页仍有下一页头）告警截断（族 B 收口回归）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const acct: PlatformAccount = { platform: 'gitlab', token: 'tk', baseUrl: '' }
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      old_path: `f${i}.ts`,
      new_path: `f${i}.ts`,
      diff: '@@ -1 +1 @@',
    }))
    // 每页都带 x-next-page → 10 页耗尽后 warn；preferredDiffEndpoint 缓存使重试只走一次成功端点
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(
        ok({
          iid: 7,
          title: 't',
          state: 'opened',
          author: { username: 'alice' },
          source_branch: 'feat',
          target_branch: 'main',
          web_url: 'https://gitlab.com/g/app/-/merge_requests/7',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }),
      ) // MR 详情
      .mockResolvedValue({ status: 200, headers: { 'x-next-page': '99' }, body: JSON.stringify(fullPage) })
    const detail = await gitlabProvider.getPullRequestDetail(acct, 'g/app', 7)
    expect(detail.files).toHaveLength(1000)
    const truncWarn = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('diff 翻页达护栏'))
    expect(truncWarn).toBeDefined()
    expect(truncWarn).toContain('[gitlab] g/app#7')
  })
})

describe('gitee 评论 API', () => {
  it('list：独立 PR 评论端点（非 issue comments）+ Bearer，不带无效排序参数（评审 #41）；时间戳排序兜底；单页即止', async () => {
    vi.mocked(httpRequest).mockResolvedValue(
      ok([
        { id: 3, body: '评论', created_at: '2026-01-01T00:00:02Z' },
        { id: 4, body: '更早', created_at: '2026-01-01T00:00:01Z' },
      ]),
    )
    const { comments, truncated } = await giteeProvider.listPullRequestComments(
      { platform: 'gitee', token: 'tk', baseUrl: '' },
      'acme/app',
      9,
    )
    // URL 不含 sort/direction（go-gitee SDK 确认该接口无排序参数，传了无效）
    expect(comments).toEqual([
      { id: 4, body: '更早', createdAt: Date.parse('2026-01-01T00:00:01Z') },
      { id: 3, body: '评论', createdAt: Date.parse('2026-01-01T00:00:02Z') },
    ])
    expect(truncated).toBe(false)
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe('https://gitee.com/api/v5/repos/acme/app/pulls/9/comments?per_page=100&page=1')
    expect(req.url).not.toContain('sort=')
    expect(req.url).not.toContain('direction=')
    expect(req.headers?.Authorization).toBe('Bearer tk')
    expect(vi.mocked(httpRequest).mock.calls).toHaveLength(1)
  })

  it('list 翻页：满 100 条继续下一页（评审 #32）', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `c${i}`,
      created_at: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    }))
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok(full))
      .mockResolvedValueOnce(ok([{ id: 999, body: '最新汇总评论', created_at: '2026-02-01T00:00:00Z' }]))
    const { comments, truncated } = await giteeProvider.listPullRequestComments(
      { platform: 'gitee', token: 'tk', baseUrl: '' },
      'acme/app',
      9,
    )
    expect(comments).toHaveLength(101)
    expect(comments[100]?.body).toBe('最新汇总评论')
    expect(truncated).toBe(false)
    expect(vi.mocked(httpRequest).mock.calls[1][0].url).toContain('&page=2')
  })

  it('list 正常收尾（末页不满 100）：不告警、truncated=false（评审 #34/#42）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` }))
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok(full))
      .mockResolvedValueOnce(ok([{ id: 999, body: '最新汇总评论' }]))
    const normal = await giteeProvider.listPullRequestComments(
      { platform: 'gitee', token: 'tk', baseUrl: '' },
      'acme/app',
      9,
    )
    expect(normal.truncated).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('list 翻页护栏触发（末页仍满页）：告警截断 + truncated 标记（评审 #34/#42）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `c${i}` }))
    // 护栏路径：每页都满 100 条，20 页耗尽后循环退出 → warn + truncated
    vi.mocked(httpRequest).mockResolvedValue(ok(full))
    const { truncated } = await giteeProvider.listPullRequestComments(
      { platform: 'gitee', token: 'tk', baseUrl: '' },
      'acme/app',
      9,
    )
    expect(truncated).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('[gitee] acme/app#9')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('2000')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('截断')
  })

  it('list 失败：非 2xx 抛出含平台名与状态码的错误（评审 #39）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 404, headers: {}, body: '{"message":"not found"}' })
    await expect(
      giteeProvider.listPullRequestComments(
        { platform: 'gitee', token: 'tk', baseUrl: '' },
        'acme/app',
        9,
      ),
    ).rejects.toThrow('Gitee API 404')
  })

  it('list 2xx 但响应体非 JSON：抛出带平台与端点上下文的业务错误（评审 #50）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 200, headers: {}, body: 'gateway timeout html' })
    await expect(
      giteeProvider.listPullRequestComments(
        { platform: 'gitee', token: 'tk', baseUrl: '' },
        'acme/app',
        9,
      ),
    ).rejects.toThrow(/Gitee API 返回了非 JSON 响应.*pulls\/9\/comments.*gateway timeout/)
  })

  it('自定义 baseUrl 生效：upsert URL（评审 #30；#55 钉死 method 防与同 URL 的 list GET 混淆）', async () => {
    const acct: PlatformAccount = { platform: 'gitee', token: 'tk', baseUrl: 'https://gitee.example.com/' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 8 }))
    await giteeProvider.upsertPullRequestComment(acct, 'acme/app', 9, null, '正文')
    const req = vi.mocked(httpRequest).mock.calls[0][0]
    expect(req.url).toBe('https://gitee.example.com/api/v5/repos/acme/app/pulls/9/comments')
    expect(req.method).toBe('POST')
  })

  it('自定义 baseUrl 生效：list URL（防御脏值残留）', async () => {
    const acct: PlatformAccount = { platform: 'gitee', token: 'tk', baseUrl: 'https://gitee.example.com/' }
    vi.mocked(httpRequest).mockResolvedValue(ok([]))
    const { comments } = await giteeProvider.listPullRequestComments(acct, 'acme/app', 9)
    const listReq = vi.mocked(httpRequest).mock.calls[0][0]
    expect(listReq.url).toBe(
      'https://gitee.example.com/api/v5/repos/acme/app/pulls/9/comments?per_page=100&page=1',
    )
    expect(comments).toEqual([])
  })

  it('upsert 发布：POST form-urlencoded（特殊字符经 URLSearchParams 编码）', async () => {
    const acct: PlatformAccount = { platform: 'gitee', token: 'tk', baseUrl: '' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 8 }))
    await giteeProvider.upsertPullRequestComment(acct, 'acme/app', 9, null, '正文&特殊=字符')
    const post = vi.mocked(httpRequest).mock.calls[0][0]
    expect(post.url).toBe('https://gitee.com/api/v5/repos/acme/app/pulls/9/comments')
    expect(post.method).toBe('POST')
    expect(post.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(post.body).toBe(`body=${encodeURIComponent('正文&特殊=字符')}`)
  })

  it('upsert 更新：PATCH /pulls/comments/{id}（编辑端点不带 PR 号）', async () => {
    const acct: PlatformAccount = { platform: 'gitee', token: 'tk', baseUrl: '' }
    vi.mocked(httpRequest).mockResolvedValue(ok({ id: 8 }))
    await giteeProvider.upsertPullRequestComment(acct, 'acme/app', 9, 8, '新正文')
    const patch = vi.mocked(httpRequest).mock.calls[0][0]
    expect(patch.url).toBe('https://gitee.com/api/v5/repos/acme/app/pulls/comments/8')
    expect(patch.method).toBe('PATCH')
  })

  it('detail：PR 详情端点 2xx 但响应体非 JSON，抛带端点上下文的错误（族 A 收口回归）', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ status: 200, headers: {}, body: '<html>限流页</html>' })
    await expect(
      giteeProvider.getPullRequestDetail({ platform: 'gitee', token: 'tk', baseUrl: '' }, 'acme/app', 9),
    ).rejects.toThrow(/Gitee API 返回了非 JSON 响应.*pulls\/9 详情.*<html>/)
  })

  it('detail：文件列表端点 2xx 但响应体非 JSON，抛带端点上下文的错误（族 A 收口回归）', async () => {
    const acct: PlatformAccount = { platform: 'gitee', token: 'tk', baseUrl: '' }
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(ok({ number: 9, title: 't' }))
      .mockResolvedValueOnce({ status: 200, headers: {}, body: 'maintenance' })
    await expect(giteeProvider.getPullRequestDetail(acct, 'acme/app', 9)).rejects.toThrow(
      /Gitee API 返回了非 JSON 响应.*pulls\/9\/files.*maintenance/,
    )
  })
})
