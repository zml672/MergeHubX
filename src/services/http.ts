import { invoke, Channel } from '@tauri-apps/api/core'

export interface HttpOptions {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutSecs?: number
}

export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: string
}

export async function httpRequest(options: HttpOptions): Promise<HttpResult> {
  return invoke<HttpResult>('http_request', { options })
}

export interface HttpStreamChunkEvent {
  kind: 'chunk'
  data: string
}

export interface HttpStreamResult {
  status: number
  headers: Record<string, string>
  body: string | null
}

/** 经 Rust 代理发起流式 HTTP 请求，逐块回调文本。超时兜底由 Rust 侧强制
 * （连接 10s / 空闲 90s / 总时长 600s，见 src-tauri/src/commands.rs http_request_stream），
 * JS 侧不重复设置——流式的超时语义是「空闲 + 总时长」双上限，与非流式的固定超时不同 */
export async function httpStreamRequest(
  options: HttpOptions,
  onChunk: (text: string) => void,
  requestId?: string,
): Promise<HttpStreamResult> {
  const channel = new Channel<HttpStreamChunkEvent>()
  channel.onmessage = (event) => {
    if (event.kind === 'chunk' && event.data) onChunk(event.data)
  }
  return invoke<HttpStreamResult>('http_request_stream', {
    options,
    onEvent: channel,
    requestId,
  })
}

export function httpStreamCancel(requestId: string): Promise<void> {
  return invoke<void>('http_stream_cancel', { requestId })
}
