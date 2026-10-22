<script setup lang="ts">
// R5 检查更新（设置 → 关于）：手动检查 + updater 插件一键安装（配置就绪时）+ Releases 页兜底
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { openUrl } from '@tauri-apps/plugin-opener'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { arch, platform } from '@tauri-apps/plugin-os'
import { message } from 'ant-design-vue'
import { httpRequest } from '../../services/http'
import { useUiStore } from '../../stores/ui'
import {
  compareVersions,
  findAssetForPlatform,
  LATEST_JSON_URL,
  parseLatestJson,
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  type ReleaseAsset,
  type TargetArch,
  type TargetPlatform,
} from '../../services/update'

const currentVersion = ref('')
const checking = ref(false)
const ui = useUiStore()
/** null=尚未检查；available=false=已是最新；available=true=有新版 */
const result = ref<{ available: boolean; version: string; notes: string; pubDate: string } | null>(
  null,
)
const failed = ref(false)
/** 检查失败的标题/详情（评审 10-22 末：latest.json 404 不是网络故障，单独友好提示） */
const failedTitle = ref('检查失败')
const failMessage = ref('无法连接更新服务器，请检查网络后重试。')
/** latest.json 不存在（当前最新 release 未生成自动更新清单）时的引导按钮 */
const manifestMissing = ref(false)
const downloadUrl = ref<string | null>(null)
/** 检查阶段提示（评审三轮：手动链路两请求并行，最坏等待从 ~30s 降到 ~15s，但仍需文案反馈进度） */
const checkPhase = ref('')
/** updater 插件可用（配置了 pubkey）时的待安装更新对象；null=不可用，走浏览器下载兜底。
 *  Update 是带 #private 品牌的 Rust 资源类，必须 shallowRef：深响应会剥掉品牌类型，也无须代理其内部 */
const pendingUpdate = shallowRef<Update | null>(null)
const installing = ref(false)
const installed = ref(false)
const releasesUrl = RELEASES_PAGE_URL

function open(url: string): void {
  openUrl(url).catch(() => message.error('打开链接失败，请手动访问 Releases 页'))
}

/** 释放 Update 对象持有的 Rust 侧资源；失败只吞掉，不阻塞主流程 */
async function closeUpdate(update: Update | null | undefined): Promise<void> {
  if (!update) return
  try {
    await update.close()
  } catch {
    /* 释放失败不阻塞主流程 */
  }
}

/** 安装完成后重启应用使更新生效 */
async function restartToUpdate(): Promise<void> {
  try {
    await relaunch()
  } catch {
    message.error('重启失败，请手动退出并重新打开应用')
  }
}

/** updater 插件链路检查结果（评审四轮：区分「插件正常但无更新」与「插件不可用」——
 *  前者直接下结论不再走手动兜底，避免重复网络请求且两链路口径可能不一致） */
type UpdaterCheckResult =
  | { state: 'none' } // 插件正常工作，远端无更新
  | { state: 'unavailable' } // 插件不可用（endpoints/pubkey 未配置或网络失败），调用方走手动兜底
  | { state: 'update'; update: Update } // 插件正常，发现待安装更新

async function tryUpdaterCheck(): Promise<UpdaterCheckResult> {
  try {
    const update = await check({ timeout: 15000 })
    return update ? { state: 'update', update } : { state: 'none' }
  } catch {
    return { state: 'unavailable' }
  }
}

async function installPending(): Promise<void> {
  const update = pendingUpdate.value
  if (!update || installing.value) return
  installing.value = true
  try {
    await update.downloadAndInstall()
    installed.value = true
    message.success('更新已下载，重启应用后生效')
  } catch (err) {
    // 评审四轮：安装按钮只在插件/启动移交链路渲染，彼时 downloadUrl 必为 null（手动链路
    // 不渲染该按钮），固定指向 Releases 页——不再保留不可达的三元分支
    message.error(`自动安装失败：${err instanceof Error ? err.message : String(err)}，请在下方前往 Releases 页手动下载`)
  } finally {
    // 评审 10-22：Update 用完（无论成败）必须 close 释放资源；失败后重新检查可拿到新对象
    pendingUpdate.value = null
    await closeUpdate(update)
    installing.value = false
  }
}

let disposed = false

/** 下载直链域名白名单（评审三轮：手动链路无签名校验，host 不合规即丢弃该资产）。
 *  用 URL 解析而非字符串匹配（防 "https://evil.com/?x=github.com" 绕过）；
 *  评审四轮：协议必须 https——http 明文通道可被中间人替换可执行文件 */
function isTrustedReleaseUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return (
      host === 'github.com' ||
      host.endsWith('.github.com') ||
      host === 'objects.githubusercontent.com' ||
      host.endsWith('.objects.githubusercontent.com')
    )
  } catch {
    return false
  }
}

async function checkNow(): Promise<void> {
  if (checking.value || installing.value) return
  checking.value = true
  failed.value = false
  failedTitle.value = '检查失败'
  failMessage.value = '无法连接更新服务器，请检查网络后重试。'
  manifestMissing.value = false
  result.value = null
  downloadUrl.value = null
  installed.value = false
  checkPhase.value = '正在连接更新服务器…'
  // 评审 10-22：丢弃旧 Update 前先释放，避免 Rust 侧资源泄漏
  const staleUpdate = pendingUpdate.value
  pendingUpdate.value = null
  void closeUpdate(staleUpdate)
  try {
    // 优先走 updater 插件（配置了 pubkey 时可用，能拿到签名校验过的一键安装通道）
    const viaPlugin = await tryUpdaterCheck()
    if (disposed) {
      if (viaPlugin.state === 'update') await closeUpdate(viaPlugin.update)
      return
    }
    if (viaPlugin.state === 'none') {
      // 插件正常工作且无更新：直接下结论，不走手动兜底（评审四轮：避免重复请求与口径不一致）
      result.value = { available: false, version: '', notes: '', pubDate: '' }
      return
    }
    if (viaPlugin.state === 'update') {
      const update = viaPlugin.update
      const version = update.version ?? ''
      // 评审五轮：getVersion 失败时 currentVersion 为「未知」，数值比较失去意义（非法段按 0）；
      // 插件返回 Update 即 Rust 侧已按编译期版本判定有更新，此时直接采信插件结论
      const knownCurrent = /^\d+\.\d+(\.\d+)?$/.test(currentVersion.value)
      const available = knownCurrent ? compareVersions(version, currentVersion.value) > 0 : true
      result.value = {
        available,
        version: available ? version : '',
        notes: update.body ?? '',
        pubDate: update.date ?? '',
      }
      if (available) pendingUpdate.value = update
      else await closeUpdate(update) // 判定无需更新：用完即释放
      return
    }
    // viaPlugin.state === 'unavailable'（pubkey 未配置等）：手动链路兜底
    // no-cache：更新检查必须拿最新数据，代理层不得回缓存（同 R2 的 10-20 修复口径）。
    // 评审三轮：latest.json 与 Releases API 并行（串行最坏 ~30s），API 失败不阻塞版本判定
    checkPhase.value = '正在获取发布信息…'
    const [jsonRes, apiRes] = await Promise.all([
      httpRequest({
        url: LATEST_JSON_URL,
        headers: { 'Cache-Control': 'no-cache' },
        timeoutSecs: 15,
      }),
      httpRequest({
        url: RELEASES_API_URL,
        headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
        timeoutSecs: 8,
      }).catch(() => null), // 资产直链拿不到不阻塞「发现新版」，退 Releases 页兜底
    ])
    checkPhase.value = ''
    if (jsonRes.status === 404) {
      // latest.json 不存在：最新 release 发布时未生成自动更新清单（如 0.4.0 按评审移除
      // updater 配置后打包，tauri-action 不产出清单）。不是网络故障，友好引导去 Releases 页
      failed.value = true
      failedTitle.value = '暂无自动更新信息'
      failMessage.value =
        '当前最新版本未提供自动更新清单（发布时未启用自动更新），可前往 Releases 页手动查看或下载安装包。'
      manifestMissing.value = true
      return
    }
    if (jsonRes.status < 200 || jsonRes.status >= 300) {
      throw new Error(`更新服务器返回 ${jsonRes.status}`)
    }
    const parsed = parseLatestJson(jsonRes.body, currentVersion.value)
    if (!parsed) throw new Error('更新数据格式异常（可能是网络代理返回了错误页面）')
    result.value = parsed
    if (parsed.available && apiRes && apiRes.status >= 200 && apiRes.status < 300) {
      // 评审三轮：browser_download_url 必须来自 GitHub 官方域（URL 解析校验 host，
      // 防代理/中间人伪造响应把用户引到任意站点的可执行文件），不合规资产直接丢弃
      let assets: ReleaseAsset[] = []
      try {
        const raw = JSON.parse(apiRes.body) as {
          assets?: { name: string; browser_download_url: string }[]
        }
        assets = (raw.assets ?? [])
          .filter((a) => isTrustedReleaseUrl(a.browser_download_url))
          .map((a) => ({ name: a.name, url: a.browser_download_url }))
      } catch {
        /* 兜底链接已就位 */
      }
      const asset = findAssetForPlatform(assets, detectPlatform(), detectArch())
      downloadUrl.value = asset?.url ?? null
    }
  } catch (err) {
    failed.value = true
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    checkPhase.value = ''
    checking.value = false
  }
}

/** 平台标识归一到 update.findAssetForPlatform 的键（win32/darwin/linux），其余视作未知。
 *  优先 plugin-os（编译期注入，评审 10-22 二轮：navigator.platform 已废弃且不可靠），
 *  插件未注册（如纯浏览器 dev）时降级回 navigator.platform 粗判 */
function detectPlatform(): TargetPlatform | 'unknown' {
  try {
    const p = platform()
    if (p === 'windows') return 'win32'
    if (p === 'macos') return 'darwin'
    if (p === 'linux') return 'linux'
    return 'unknown'
  } catch {
    const p = navigator.platform.toLowerCase()
    if (p.includes('win')) return 'win32'
    if (p.includes('mac')) return 'darwin'
    if (p.includes('linux')) return 'linux'
    return 'unknown'
  }
}

/** 架构标识归一到 update.findAssetForPlatform 的键（x86_64/aarch64 等）。
 *  评审三轮：插件不可用时的降级一律返回 unknown 跳过架构过滤——navigator.platform
 *  在 macOS ARM 上报 'MacIntel'、Windows ARM 上报 'Win32'，任何关键字猜测都会把
 *  ARM 机器误配 x64 包；宁可不挑架构（走「前往 Releases」兜底）也不误配 */
function detectArch(): TargetArch | 'unknown' {
  try {
    const a = arch()
    if (a === 'x86_64' || a === 'aarch64' || a === 'x86' || a === 'arm') return a
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

onUnmounted(() => {
  disposed = true
  // 评审 10-22：组件卸载时释放未使用的 Update，避免 Rust 侧资源泄漏
  void closeUpdate(pendingUpdate.value)
  pendingUpdate.value = null
})

onMounted(async () => {
  try {
    currentVersion.value = await getVersion()
  } catch {
    currentVersion.value = '未知'
  }
  // 消费启动静默检查的结果（MainLayout 横幅引到这里）：
  // 直接接管启动检查移交的 Update 对象（含签名下载通道），免二次请求
  if (ui.startupUpdate) {
    result.value = {
      available: true,
      version: ui.startupUpdate.version,
      notes: ui.startupUpdate.notes,
      pubDate: '',
    }
    pendingUpdate.value = ui.startupUpdate.update
    ui.startupUpdate = null
  }
})
</script>

<template>
  <div>
    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 16px"
      message="应用更新"
      :description="`当前版本 ${currentVersion || '读取中…'}。点击「检查更新」会访问 GitHub Releases 获取最新版本信息。`"
    />
    <a-space direction="vertical" :size="12" style="width: 100%">
      <a-button type="primary" :loading="checking" @click="checkNow">检查更新</a-button>
      <div v-if="checking && checkPhase" style="color: rgba(0, 0, 0, 0.45); font-size: 12px">
        {{ checkPhase }}
      </div>

      <a-alert
        v-if="result && !result.available"
        type="success"
        show-icon
        :message="`已是最新版本（${currentVersion}）`"
        description="当前已是最新版本，无需更新。"
      />

      <a-alert v-else-if="result && result.available" type="warning" show-icon
        :message="`发现新版本 v${result.version}`">
        <template #description>
          <div style="white-space: pre-wrap">{{ result.notes || '暂无更新说明。' }}</div>
          <div style="margin-top: 8px">
            <template v-if="installed">
              <a-button type="primary" size="small" @click="restartToUpdate">
                立即重启完成更新
              </a-button>
              <span style="margin-left: 8px">更新已就绪，稍后重启同样生效。</span>
            </template>
            <template v-else>
              <a-button
                v-if="pendingUpdate"
                type="primary"
                size="small"
                :loading="installing"
                @click="installPending"
              >
                {{ installing ? '正在下载安装…' : '一键安装' }}
              </a-button>
              <a-button
                v-if="downloadUrl"
                :type="pendingUpdate ? 'default' : 'primary'"
                size="small"
                :style="pendingUpdate ? 'margin-left: 8px' : ''"
                @click="open(downloadUrl)"
              >
                下载安装包
              </a-button>
              <a-button size="small" style="margin-left: 8px" @click="open(releasesUrl)">
                前往 Releases 页
              </a-button>
            </template>
          </div>
        </template>
      </a-alert>

      <a-alert v-else-if="failed" type="error" show-icon :message="failedTitle">
        <template #description>
          <div>{{ failMessage }}</div>
          <a-button
            v-if="manifestMissing"
            size="small"
            style="margin-top: 8px"
            @click="open(releasesUrl)"
          >
            前往 Releases 页
          </a-button>
        </template>
      </a-alert>
    </a-space>
  </div>
</template>
