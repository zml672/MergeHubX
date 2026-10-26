// @vitest-environment node
// 批次对话文件名的格式契约（七轮评审 #实证缺陷）：Rust 侧 append_ai_debug_log 按
// 「14 位时间戳 + '-' + 8 位 hex + '.log'」共 27 字符硬校验，不匹配整条写入被拒且
// 前端 fire-and-forget 静默——格式漂移 = 对话日志无声丢失。本文件把契约钉死：
// 主路径（beginConversationBatch）与兜底路径（appendLog 无批次时）都必须产出合法名。
// 兜底路径经 mock invoke 捕获 fileName 实参断言；正则与 Rust 校验分段口径一致
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./storage', () => ({
  loadString: () => null,
  persistJson: () => {},
  persistString: () => {},
}))
vi.mock('vue', () => ({ ref: (v: unknown) => ({ value: v }) }))

// 与 Rust 校验同口径：14 位数字 - 8 位 hex .log（27 字符）
const BATCH_NAME_RE = /^\d{14}-[0-9a-f]{8}\.log$/

async function importReal(): Promise<typeof import('../aiDebugLog')> {
  return await import('../aiDebugLog')
}

describe('批次对话文件名格式契约（27 字符，Rust 硬校验）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue({ filePath: 'x', dirPath: 'y' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('beginConversationBatch 生成的主路径批次名符合 27 字符契约', async () => {
    const mod = await importReal()
    mod.beginConversationBatch()
    mod.logAiRequest('场景', 'model-x', 'repo-a', [])
    const call = invokeMock.mock.calls.find((c) => c[0] === 'append_ai_debug_log')
    expect(call, '未发起 append_ai_debug_log 调用').toBeTruthy()
    expect(call![1].fileName).toMatch(BATCH_NAME_RE)
    expect((call![1].fileName as string).length).toBe(27)
  })

  it('未 begin 时兜底路径同样产出 27 字符合法名（曾只拼时间戳+.log 被拒）', async () => {
    const mod = await importReal()
    mod.logAiError('dir', '场景', new Error('x'), 'model-x')
    const call = invokeMock.mock.calls.find((c) => c[0] === 'append_ai_debug_log')
    expect(call, '兜底路径未发起 append_ai_debug_log 调用').toBeTruthy()
    expect(call![1].fileName).toMatch(BATCH_NAME_RE)
    expect((call![1].fileName as string).length).toBe(27)
  })

  it('批次文件在批次内复用（一次评审一个文件）', async () => {
    const mod = await importReal()
    mod.beginConversationBatch()
    mod.logAiRequest('场景', 'model-x', 'repo-a', [])
    mod.logAiRequest('场景二', 'model-x', 'repo-a', [])
    const names = invokeMock.mock.calls
      .filter((c) => c[0] === 'append_ai_debug_log')
      .map((c) => c[1].fileName as string)
    expect(names.length).toBe(2)
    expect(new Set(names).size).toBe(1)
  })
})
