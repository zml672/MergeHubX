/** 模型接口错误的解析与用户友好化：错误消息提取 + 正则映射为可行动的中文提示 */

function extractError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const msg = parsed.error?.message ?? parsed.message
    if (typeof msg === 'string' && msg) return msg
  } catch {
    /* 忽略解析失败，回退到原文 */
  }
  return body.slice(0, 300)
}

/** 常见模型接口错误的中文友好提示：按错误消息正则匹配给出可行动的建议，未命中时原样返回。
 *  排序原则：「模型接口返回 NNN」锚定规则只会由本应用自身的错误格式触发（零误判），一律优先；
 *  特征词规则兜底其后——历史上「特征词前置」是裸数字会误匹配端口号的产物，
 *  数字规则锚定化后已不适用（如 504 消息含 gateway timeout 应命中锚定的 504 而非泛化超时） */
const FRIENDLY_ERROR_RULES: [RegExp, string][] = [
  [
    /模型接口返回 429\b|rate.?limit|too many requests|请求过多|过多请求|并发过多|配额/i,
    '请求过于频繁或配额不足，请稍后重试，并检查服务商的用量与计费状态',
  ],
  [
    /模型接口返回 401\b|unauthorized|incorrect api key|invalid[ _-](api[ _-])?key/i,
    '鉴权失败：API Key 无效或已过期，请到「设置 → AI 模型」检查 Key',
  ],
  [
    /模型接口返回 403\b|forbidden/i,
    '无访问权限：当前 Key 无权调用该模型，请检查 Key 权限或模型开通状态',
  ],
  [/模型接口返回 404\b|not found/i, '接口或模型不存在：请检查 Base URL 与模型名称拼写是否正确'],
  [/模型接口返回 500\b|internal server error/i, '服务商内部错误，请稍后重试'],
  [
    /模型接口返回 50[234]\b|bad gateway|service unavailable|overloaded/i,
    '服务商暂时不可用，请稍后重试',
  ],
  [
    /模型响应中断|未收到新数据/,
    '模型响应中断：模型长时间未输出数据，请检查网络连接后重试；若反复出现，可更换模型或减小单批分析量',
  ],
  [
    /timeout|timed?[ _-]?out|etimedout|超时/i,
    '请求超时：网络不稳定或模型响应过慢，可稍后重试',
  ],
  [
    /econnreset|econnrefused|enotfound|epipe|network|failed to fetch|fetch failed|getaddrinfo|dns/i,
    '网络连接失败：请检查本机网络与 Base URL 是否可达',
  ],
  [
    /context length|maximum context|too large|too long|上下文|超长/i,
    '内容超出模型上下文长度：可改用「预算优先」模式或缩小变更范围后重试',
  ],
]

/** 把底层错误转成面向用户的中文友好提示（原始详情另行保留在日志与错误详情中） */
export function friendlyAiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  for (const [pattern, text] of FRIENDLY_ERROR_RULES) {
    if (pattern.test(message)) return text
  }
  return message
}

export { extractError }
