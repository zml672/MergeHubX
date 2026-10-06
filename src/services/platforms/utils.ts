import type { DiffFileStatus } from '../../types/platform'

function extractApiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    return typeof parsed.message === 'string' && parsed.message
      ? parsed.message
      : null
  } catch {
    return null
  }
}

export function assertOk(status: number, body: string, platform: string): void {
  if (status >= 400) {
    const detail = extractApiMessage(body) ?? body.slice(0, 300)
    throw new Error(`${platform} API ${status}: ${detail}`)
  }
}

export function splitRepo(repo: string): [string, string] {
  const parts = repo.split('/').filter(Boolean)
  if (parts.length !== 2) {
    throw new Error('仓库格式应为 owner/repo，例如 vuejs/core')
  }
  return [parts[0], parts[1]]
}

export function mapDiffStatus(status: string): DiffFileStatus {
  if (status === 'added') return 'added'
  if (status === 'removed') return 'removed'
  if (status === 'renamed') return 'renamed'
  return 'modified'
}

export function countDiffLines(patch: string): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@')
    ) {
      continue
    }
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/** 远端文件 base64 内容长度上限：与本地 read_local_file 的 1MB 上限对齐（1MB 原文 base64 后约 139.8 万字符，GitHub/Gitee 返回的 content 还含换行符、约 142 万字符，故取 150 万容差避免误拒恰好 1MB 的文件）；解码前拦截，避免超大内容的解码内存与后续复核 token 开销 */
export const MAX_REMOTE_FILE_BASE64_CHARS = 1_500_000

/** 将平台 contents 接口返回的 base64 内容解码为 UTF-8 文本（兼容平台在内容中插入的换行符） */
export function decodeBase64Text(content: string): string {
  const bin = atob(content.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}
