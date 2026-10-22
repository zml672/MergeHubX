// R5 检查更新：GitHub Releases latest.json 的解析与版本比较（纯逻辑，UI 在设置页组件）
// 设计要点：不引第三方 semver 依赖——应用自身版本就是 x.y.z 三段，逐段数值比较足够；
// 畸形响应（代理返回 HTML / 字段缺失 / 类型不对）一律返回 null，调用方展示「检查失败」

/** 语义化版本比较（semver 2.0.0 优先级规则）：
 *  1. 主版本段（x.y.z）逐段数值比较，缺失段补 0；
 *  2. 主版本段相等时，预发布版低于正式版（1.0.0-rc.1 < 1.0.0——正式版用户不会被推 rc，
 *     beta/rc 用户在正式版发布后能收到更新；评审 10-22 二轮：仅剥离后缀判等会漏掉这半边）；
 *  3. 双方都有预发布标识时按 '.' 分段逐段比：纯数字段按数值、数字段 < 字母段、
 *     字母段按 ASCII 字典序、前面全等时段数多者大；
 *  4. 构建元数据（+ 后缀）不参与优先级。 */
export function compareVersions(a: string, b: string): number {
  const isNumSegment = (s: string): boolean => /^\d+$/.test(s)
  const parse = (v: string) => {
    // semver 文法：主版本-预发布+构建元数据；构建元数据（+ 后）不参与优先级，
    // 须先剥离再定位预发布（split /[-+]/ 会把 + 后的元数据误当预发布标识，测试已钉死该坑）
    const stripped = v.replace(/^v/i, '')
    const plusIdx = stripped.indexOf('+')
    const coreAndPre = plusIdx >= 0 ? stripped.slice(0, plusIdx) : stripped
    const dashIdx = coreAndPre.indexOf('-')
    const nums = (dashIdx >= 0 ? coreAndPre.slice(0, dashIdx) : coreAndPre)
      .split('.')
      .map((seg) => {
        const n = Number.parseInt(seg, 10)
        return Number.isFinite(n) ? n : 0
      })
    // 预发布标识（- 后按 '.' 分段）；无则 null = 正式版
    const pre = dashIdx >= 0 ? coreAndPre.slice(dashIdx + 1).split('.') : null
    return { nums, pre }
  }
  const [pa, pb] = [parse(a), parse(b)]
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  // 主版本段相等：semver 规则 11——预发布 < 正式版
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  // 双方都是预发布：逐标识比较
  const plen = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < plen; i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // 前段全等，段少者小
    if (y === undefined) return 1
    if (isNumSegment(x) && isNumSegment(y)) {
      const nx = Number.parseInt(x, 10)
      const ny = Number.parseInt(y, 10)
      if (nx !== ny) return nx > ny ? 1 : -1
    } else if (isNumSegment(x) !== isNumSegment(y)) {
      return isNumSegment(x) ? -1 : 1 // 数字标识 < 字母标识
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export interface UpdateInfo {
  available: boolean
  version: string
  notes: string
  pubDate: string
}

/** latest.json（tauri-action 产物）解析：仅当远端版本更高时 available=true。
 *  返回 null = 响应不可信（非 JSON / 缺 version / version 非字符串 / 顶层非对象） */
export function parseLatestJson(body: string, currentVersion: string): UpdateInfo | null {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'string' || !obj.version) return null
  // 评审五轮：形态锚定校验（2~3 段纯数字 + 可选预发布后缀）——compareVersions 对非法段
  // 按 0 处理，"9"/"2026" 这类单段畸形版本会被误判高于当前版本，展示拿不到资产的假更新；
  // 预发布后缀是合法形态（compareVersions 支持），须放行
  if (!/^v?\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?$/i.test(obj.version)) return null
  const available = compareVersions(obj.version, currentVersion) > 0
  return {
    available,
    version: available ? obj.version : '',
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    pubDate: typeof obj.pub_date === 'string' ? obj.pub_date : '',
  }
}

export interface ReleaseAsset {
  name: string
  url: string
}

/** 平台标识：与 Node 的 process.platform 对齐（浏览器端由 plugin-os platform() 归一） */
export type TargetPlatform = 'win32' | 'darwin' | 'linux'

/** 架构标识：与 plugin-os arch() 返回值子集对齐（只关心实际发产物的主流架构） */
export type TargetArch = 'x86' | 'x86_64' | 'arm' | 'aarch64' | 'unknown'

/** 资产名中的架构关键词（评审 10-22 二/三轮：ARM 机器不得拿到 x64 包，32 位包不得发给 64 位机）。
 *  各平台产物命名不一（x64/x86_64/amd64、arm64/aarch64、i386~i686/armv7），用关键词集合宽容匹配；
 *  x86 用负向断言排除 x86_64（'x86_64' 含 'x86' 子串） */
const ARCH_KEYWORDS: Partial<Record<TargetArch, RegExp>> = {
  x86: /(?:x86(?![_-]?64))|ia32|i[3-6]86/i,
  x86_64: /x64|x86[_-]?64|amd64/i,
  arm: /armv[4-7]|armel|armhf/i,
  aarch64: /aarch64|arm64/i,
}

/** 按当前平台+架构匹配下载资产：Windows 优先 NSIS 安装包（exe）退 msi；macOS app.tar.gz；Linux AppImage。
 *  显式排除 latest.json 与校验和类元数据文件；名字带架构关键词的资产只留给对应架构，
 *  关键词全无的视为架构无关保留；无匹配返回 null（调用方给「前往 Releases」兜底链接） */
export function findAssetForPlatform(
  assets: ReleaseAsset[],
  platform: TargetPlatform | 'unknown',
  arch: TargetArch = 'unknown',
): ReleaseAsset | null {
  const candidates = assets.filter(
    (a) => !/^latest\.json$/i.test(a.name) && !/sha256|checksum/i.test(a.name),
  )
  const archFiltered =
    arch === 'unknown'
      ? candidates
      : candidates.filter((a) => {
          for (const [key, re] of Object.entries(ARCH_KEYWORDS) as [TargetArch, RegExp][]) {
            if (re.test(a.name) && key !== arch) return false
          }
          return true
        })
  const matchers: Record<TargetPlatform, RegExp[]> = {
    win32: [/\.exe$/i, /\.msi$/i],
    darwin: [/\.app\.tar\.gz$/i, /\.dmg$/i],
    linux: [/\.AppImage$/i],
  }
  for (const pattern of matchers[platform as TargetPlatform] ?? []) {
    const hit = archFiltered.find((a) => pattern.test(a.name))
    if (hit) return hit
  }
  return null
}

/** GitHub Releases latest.json 地址（公共仓库 zml672/MergeHubX） */
export const LATEST_JSON_URL =
  'https://github.com/zml672/MergeHubX/releases/latest/download/latest.json'

/** GitHub Releases latest release API（手动链路拉安装包资产列表） */
export const RELEASES_API_URL = 'https://api.github.com/repos/zml672/MergeHubX/releases/latest'

/** 仓库 Releases 页（无匹配资产时的兜底跳转） */
export const RELEASES_PAGE_URL = 'https://github.com/zml672/MergeHubX/releases'
