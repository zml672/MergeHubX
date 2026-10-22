<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import MainLayout from './layouts/MainLayout.vue'
import { useAiStore } from './stores/ai'
import { usePrsStore } from './stores/prs'
import { useSettingsStore } from './stores/settings'
import { useUiStore } from './stores/ui'
import { PLATFORMS } from './types/platform'

dayjs.locale('zh-cn')

const settings = useSettingsStore()
const prs = usePrsStore()
const ai = useAiStore()
const ui = useUiStore()

let startupTimer: ReturnType<typeof setTimeout> | null = null
/** 卸载标志（评审四轮）：3 秒延时的检查若在卸载后才 resolve，
 *  写入 ui.startupUpdate 已无消费方，须立即释放该 Update */
let appDisposed = false

onMounted(async () => {
  await Promise.all([ai.load(), settings.loadPushPrefs(), ...PLATFORMS.map((p) => settings.loadAccount(p))])
  prs.startPolling()
  // R5 启动静默检查更新：延后 3 秒避开启动竞态（登录加载/PR 轮询首拉优先占网络）；
  // updater 插件未配置 pubkey（占位符配置已按评审 10-22 移除）或网络失败时 check() 抛错——完全静默，不打扰启动
  startupTimer = window.setTimeout(() => {
    void (async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check({ timeout: 15000 })
        if (!update) return
        if (appDisposed) {
          // 卸载后才 resolve：无人消费，立即释放防 Rust 侧资源泄漏
          void update.close().catch(() => {})
          return
        }
        // Update 不再读完字段就丢弃（那样会泄漏 Rust 侧资源），
        // 整体移交 ui store；AppUpdate 页接管后负责使用并在用毕/卸载时 close；
        // 顺带消除评审提到的「启动查一次、设置页再查一次」的重复请求
        ui.startupUpdate = { version: update.version ?? '', notes: update.body ?? '', update }
      } catch {
        /* 静默失败 */
      }
    })()
  }, 3000)
})

onUnmounted(() => {
  appDisposed = true
  if (startupTimer !== null) window.clearTimeout(startupTimer)
  // 评审 10-22 二轮：启动检查移交的 Update 若始终无人消费（用户没打开「关于」页签），
  // 也要在应用卸载时释放，避免 Rust 侧资源持有到进程退出
  ui.disposeStartupUpdate()
})
</script>

<template>
  <a-config-provider :locale="zhCN">
    <MainLayout />
  </a-config-provider>
</template>
