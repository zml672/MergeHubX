// @vitest-environment node
// R5 检查更新：版本比较、latest.json 解析校验、下载资产匹配——纯逻辑钉死
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  findAssetForPlatform,
  parseLatestJson,
  type UpdateInfo,
} from '../update'

describe('compareVersions 语义化版本比较', () => {
  it.each([
    ['0.4.0', '0.4.1', -1],
    ['0.4.0', '0.4.0', 0],
    ['0.4.1', '0.4.0', 1],
    ['0.4.0', '0.5.0', -1],
    ['0.9.9', '1.0.0', -1],
    ['1.0.0', '0.9.9', 1],
    ['0.10.0', '0.9.0', 1], // 逐段数值比较，不是字典序
    ['0.4.0', '0.4.10', -1],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it('带 v 前缀的版本号归一处理', () => {
    expect(compareVersions('v0.4.0', '0.5.0')).toBe(-1)
    expect(compareVersions('0.4.0', 'v0.4.0')).toBe(0)
  })

  it('段数不齐按缺失补 0（0.4 ≈ 0.4.0）', () => {
    expect(compareVersions('0.4', '0.4.0')).toBe(0)
    expect(compareVersions('0.4', '0.4.1')).toBe(-1)
  })

  it('非数字段防御：解析失败段按 0 处理，不抛异常', () => {
    expect(compareVersions('abc', '0.0.1')).toBe(-1)
  })

  it('预发布 < 同版本号正式版（semver 规则 11，评审 10-22 二轮）', () => {
    // 正式版用户不被推 rc：1.0.0-rc.1 低于 1.0.0（修复前切分得 4 段被误判 +1，一轮修复后判等、二轮补全语义）
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    // beta 用户能收到正式版更新：0.5.0-beta < 0.5.0（一轮修复判等导致收不到，二轮修复）
    expect(compareVersions('0.5.0-beta', '0.5.0')).toBe(-1)
    // 反向同样成立
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
  })

  it('预发布与正式版真实高低关系不受后缀影响', () => {
    expect(compareVersions('1.0.1-rc.1', '1.0.0')).toBe(1)
    expect(compareVersions('0.5.0-beta', '0.6.0')).toBe(-1)
    expect(compareVersions('0.4.9-rc.1', '0.4.0')).toBe(1)
  })

  it('双预发布按 semver 标识比较：数值段比大小、数字段 < 字母段、字典序', () => {
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1) // 数字标识 < 字母标识
    expect(compareVersions('1.0.0-rc.1.1', '1.0.0-rc.1')).toBe(1) // 前段全等，段多者大
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
  })

  it('构建元数据后缀（+）不参与优先级', () => {
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0+build.5', '1.0.0-beta')).toBe(1) // 元数据不影响预发布比较
  })
})

describe('parseLatestJson latest.json 解析校验', () => {
  const base = {
    version: '0.5.0',
    notes: '修复了若干问题',
    pub_date: '2026-10-21T00:00:00Z',
    platforms: {},
  }

  it('新版可更新：返回结构化结果', () => {
    const r = parseLatestJson(JSON.stringify(base), '0.4.0')
    expect(r).toEqual({
      available: true,
      version: '0.5.0',
      notes: '修复了若干问题',
      pubDate: '2026-10-21T00:00:00Z',
    })
  })

  it('同版本 / 更旧版本：available=false 且不透出版本号', () => {
    expect(parseLatestJson(JSON.stringify(base), '0.5.0')?.available).toBe(false)
    expect(parseLatestJson(JSON.stringify(base), '1.0.0')?.available).toBe(false)
  })

  it('缺失 notes/pub_date 容错为空', () => {
    const r: UpdateInfo = parseLatestJson(JSON.stringify({ version: '0.5.0' }), '0.4.0')!
    expect(r.available).toBe(true)
    expect(r.notes).toBe('')
    expect(r.pubDate).toBe('')
  })

  it.each([
    ['<html>不是 JSON</html>', 'HTML 错误页'],
    ['{"notes":"缺版本号"}', '缺 version 字段'],
    ['{"version":42}', 'version 非字符串'],
    ['[]', '数组而非对象'],
    ['{"version":"9"}', '单段畸形版本（评审五轮：会被误判高于当前）'],
    ['{"version":"2026"}', '纯年数畸形版本'],
  ])('畸形响应（%s）→ null（%s）', (body) => {
    expect(parseLatestJson(body, '0.4.0')).toBeNull()
  })

  it('version 形态校验边界（评审五轮）', () => {
    // 合法形态照常解析（含预发布后缀，compareVersions 支持）
    expect(parseLatestJson(JSON.stringify({ version: '0.5.0' }), '0.4.0')?.available).toBe(true)
    expect(parseLatestJson(JSON.stringify({ version: 'v0.5.0' }), '0.4.0')?.available).toBe(true)
    expect(parseLatestJson(JSON.stringify({ version: '1.0.0-rc.1' }), '1.0.0')?.available).toBe(
      false,
    ) // 预发布低于正式版
    // 非法形态拒绝：非数字开头 / 段数超限 / 混入字母段
    expect(parseLatestJson(JSON.stringify({ version: 'abc' }), '0.4.0')).toBeNull()
    expect(parseLatestJson(JSON.stringify({ version: '1.2.3.4' }), '0.4.0')).toBeNull()
    expect(parseLatestJson(JSON.stringify({ version: '1.x.0' }), '0.4.0')).toBeNull()
    expect(parseLatestJson(JSON.stringify({ version: '0.5.0rc1' }), '0.4.0')).toBeNull() // 后缀缺分隔符
  })
})

describe('findAssetForPlatform 下载资产匹配', () => {
  const assets = [
    { name: 'MergeHub_0.5.0_x64-setup.exe', url: 'https://x/1.exe' },
    { name: 'MergeHub_0.5.0_x64_en-US.msi', url: 'https://x/1.msi' },
    { name: 'MergeHub_0.5.0_aarch64.app.tar.gz', url: 'https://x/1.app.tar.gz' },
    { name: 'MergeHub_0.5.0_amd64.AppImage', url: 'https://x/1.AppImage' },
    { name: 'latest.json', url: 'https://x/latest.json' },
    { name: 'SHA256SUMS', url: 'https://x/sums' },
  ]

  it('Windows 优先 NSIS 安装包（exe），退而 msi', () => {
    expect(findAssetForPlatform(assets, 'win32')?.url).toBe('https://x/1.exe')
    expect(
      findAssetForPlatform(assets.filter((a) => !a.name.endsWith('.exe')), 'win32')?.url,
    ).toBe('https://x/1.msi')
  })

  it('macOS 匹配 app.tar.gz；Linux 匹配 AppImage', () => {
    expect(findAssetForPlatform(assets, 'darwin')?.url).toBe('https://x/1.app.tar.gz')
    expect(findAssetForPlatform(assets, 'linux')?.url).toBe('https://x/1.AppImage')
  })

  it('排除 latest.json 与校验和文件，不把元数据当安装包', () => {
    const onlyMeta = assets.filter((a) => ['latest.json', 'SHA256SUMS'].includes(a.name))
    expect(findAssetForPlatform(onlyMeta, 'win32')).toBeNull()
  })

  it('无匹配返回 null（调用方展示「请手动前往 Releases」兜底）', () => {
    expect(findAssetForPlatform([], 'win32')).toBeNull()
    expect(findAssetForPlatform(assets, 'unknown')).toBeNull()
  })

  it('架构过滤：x86_64 机器不拿 aarch64 包（评审 10-22 二轮）', () => {
    expect(findAssetForPlatform(assets, 'darwin', 'x86_64')).toBeNull() // 只有 aarch64 的 app.tar.gz
    const dual = [
      { name: 'MergeHub_0.5.0_x64-setup.exe', url: 'https://x/x64.exe' },
      { name: 'MergeHub_0.5.0_arm64-setup.exe', url: 'https://x/arm64.exe' },
    ]
    expect(findAssetForPlatform(dual, 'win32', 'x86_64')?.url).toBe('https://x/x64.exe')
    expect(findAssetForPlatform(dual, 'win32', 'aarch64')?.url).toBe('https://x/arm64.exe')
    // 各平台命名差异都能归一匹配（x86_64/amd64/x64 同义）
    const linuxPkgs = [
      { name: 'MergeHub_0.5.0_amd64.AppImage', url: 'https://x/amd64.AppImage' },
      { name: 'MergeHub_0.5.0_arm64.AppImage', url: 'https://x/arm64.AppImage' },
    ]
    expect(findAssetForPlatform(linuxPkgs, 'linux', 'x86_64')?.url).toBe('https://x/amd64.AppImage')
  })

  it('架构无关命名（无关键词）不参与过滤，arch unknown 时跳过架构过滤', () => {
    const plain = [{ name: 'MergeHub_0.5.0_x64-setup.exe', url: 'https://x/plain.exe' }]
    expect(findAssetForPlatform(plain, 'win32', 'unknown')?.url).toBe('https://x/plain.exe')
    const generic = [{ name: 'MergeHub-setup.exe', url: 'https://x/generic.exe' }]
    expect(findAssetForPlatform(generic, 'win32', 'aarch64')?.url).toBe('https://x/generic.exe')
  })

  it('32 位标识不误发（评审 10-22 三轮）：x86/armv7 关键词补全', () => {
    const multi = [
      { name: 'MergeHub_0.5.0_ia32-setup.exe', url: 'https://x/ia32.exe' },
      { name: 'MergeHub_0.5.0_x64-setup.exe', url: 'https://x/x64.exe' },
      { name: 'MergeHub_0.5.0_armv7.AppImage', url: 'https://x/armv7.AppImage' },
      { name: 'MergeHub_0.5.0_amd64.AppImage', url: 'https://x/amd64.AppImage' },
    ]
    // aarch64 Windows 用户：ia32（x86）与 x64（x86_64）包都被正确过滤，返回 null 走 Releases 兜底
    // （不误发 x64 正是架构过滤的目的；若未来发 arm64 Windows 包，aarch64 用户即可命中）
    expect(findAssetForPlatform(multi, 'win32', 'aarch64')).toBeNull()
    const winArm = [
      { name: 'MergeHub_0.5.0_arm64-setup.exe', url: 'https://x/winarm.exe' },
      { name: 'MergeHub_0.5.0_x64-setup.exe', url: 'https://x/x64.exe' },
    ]
    expect(findAssetForPlatform(winArm, 'win32', 'aarch64')?.url).toBe('https://x/winarm.exe')
    expect(findAssetForPlatform(multi, 'linux', 'aarch64')).toBeNull() // linux 只有 amd64/armv7，都非 aarch64
    expect(findAssetForPlatform(multi, 'linux', 'arm')?.url).toBe('https://x/armv7.AppImage')
    expect(findAssetForPlatform(multi, 'linux', 'x86_64')?.url).toBe('https://x/amd64.AppImage')
    // x86 关键词（负向断言）不误伤 x86_64 命名
    const x86Only = [{ name: 'MergeHub_0.5.0_x86-setup.exe', url: 'https://x/x86.exe' }]
    expect(findAssetForPlatform(x86Only, 'win32', 'x86')?.url).toBe('https://x/x86.exe')
    expect(findAssetForPlatform(x86Only, 'win32', 'x86_64')).toBeNull()
    // x86_64 命名（字面含 'x86' 子串）必须归入 x86_64 而非 x86——负向断言钉死
    const x64Named = [{ name: 'MergeHub_0.5.0_x86_64-setup.exe', url: 'https://x/x86_64.exe' }]
    expect(findAssetForPlatform(x64Named, 'win32', 'x86_64')?.url).toBe('https://x/x86_64.exe')
    expect(findAssetForPlatform(x64Named, 'win32', 'x86')).toBeNull()
    // i386/i686 命名同样归入 x86
    expect(
      findAssetForPlatform(
        [{ name: 'MergeHub_0.5.0_i686.AppImage', url: 'https://x/i686.AppImage' }],
        'linux',
        'x86',
      )?.url,
    ).toBe('https://x/i686.AppImage')
  })
})
