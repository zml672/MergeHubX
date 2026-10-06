import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'
import { loadString, persistString } from './storage'
import type { ChatMessage } from './ai'

/** 最近一次写入的日志文件绝对路径（持久化到 localStorage，供设置页展示） */
const LAST_PATH_KEY = 'mergehub.ai-debug.last-log-path'

function readStoredPath(): string {
  return loadString(LAST_PATH_KEY) ?? ''
}

/** 最近一次写入的日志文件路径（响应式） */
export const lastLogPath = ref(readStoredPath())

/** 落盘命令返回结构 */
interface AiLogAppendResult {
  filePath: string
  dirPath: string
}

/** 生成当天日志文件名：yyyy-MM-dd.log（按仓库每天一份） */
function todayLogName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`
}

/** FNV-1a 32 位短哈希（8 位十六进制，同步无依赖）：目录名唯一性后缀，不同标识即使可读前缀相同也由哈希区分；另供断点指纹对分片内容做轻量摘要（等长修改也会改变哈希） */
export function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 远程仓库日志目录名：remote_{平台}_{owner/repo 连字符化}_{8 位哈希}——原实现以下划线拼接 owner/repo，GitLab/Gitee 的 owner 与仓库名均允许下划线，a_b/c 与 a/b_c 会生成同名目录共用日志；哈希输入为完整标识，可读段仅辅助人眼识别（旧格式目录留作历史不再写入） */
export function remoteLogDir(platform: string, repo: string): string {
  const readable = repo.split('/').filter(Boolean).join('-')
  return `remote_${platform}_${readable}_${shortHash(`${platform}/${repo}`)}`
}

/** 本地仓库日志目录名：local_{末段目录名}_{8 位哈希}——原实现只取路径末段，不同位置的同名仓库目录（如 D:\repos\demo 与 E:\test\demo）会共用一份日志；哈希输入为分隔符归一化后的完整路径（\ 与 / 等价，大小写保留——同目录不同写法只会分成两份日志而非混用），对完整路径或裸名称均适用 */
export function localLogDir(repoPath: string): string {
  const segs = repoPath.split(/[\\/]/).filter(Boolean)
  return `local_${segs[segs.length - 1] ?? repoPath}_${shortHash(segs.join('/'))}`
}

/** 格式化时间戳为可读时间 */
function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 追加写入日志文件（fire-and-forget：失败静默，不影响评审主流程） */
function appendLog(repo: string, block: string): void {
  if (!repo) return
  invoke<AiLogAppendResult>('append_ai_debug_log', {
    repo,
    fileName: todayLogName(),
    content: block,
  })
    .then((r) => {
      lastLogPath.value = r.filePath
      persistString(LAST_PATH_KEY, r.filePath)
    })
    .catch(() => {
      /* 日志写入失败不影响主流程 */
    })
}

/** 记录一次发往模型的完整请求（请求块） */
export function logAiRequest(
  scene: string,
  model: string,
  repo: string,
  messages: ChatMessage[],
): void {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0)
  console.debug(`[ai-debug] ${scene} · ${model} · ${chars} 字符`)
  const lines = [
    '========================================',
    `[请求] ${fmtTime(Date.now())} · ${scene} · 模型 ${model} · ${chars} 字符`,
    ...messages.map((m) => `----- ${m.role} -----\n${m.content}`),
    '',
  ]
  appendLog(repo, lines.join('\n'))
}

/** 追加模型响应（响应块；请求与响应分开写入，取消或失败时也留有请求痕迹） */
export function logAiAnswer(repo: string, scene: string, answer: string): void {
  appendLog(repo, `[响应] ${fmtTime(Date.now())} · ${scene}\n${answer}\n`)
}

/** 追加错误块：请求失败时把完整错误（错误名、消息、堆栈）落盘，便于排查中断原因 */
export function logAiError(repo: string, scene: string, err: unknown, model?: string): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : ''
  const modelPart = model ? ` · 模型 ${model}` : ''
  appendLog(repo, `[错误] ${fmtTime(Date.now())} · ${scene}${modelPart}\n${message}${stack}\n`)
}

/** 打开日志所在文件夹 */
export async function openAiLogDir(): Promise<void> {
  await invoke('open_ai_log_dir')
}
