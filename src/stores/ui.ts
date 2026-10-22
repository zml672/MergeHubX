import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { Update } from '@tauri-apps/plugin-updater'

export type SettingsTabKey = 'platforms' | 'ai' | 'local' | 'about'

/** 启动静默检查发现的新版本（R5）：App.vue 挂载时写入（携带可直接安装的 Update 对象），
 *  MainLayout 弹提示，用户点击直达设置「关于」Tab，AppUpdate 组件接管对象后免二次请求直接展示 */
export interface PendingUpdateInfo {
  version: string
  notes: string
  /** 启动检查拿到的可安装对象（含签名下载通道，不能序列化复制）；由 store 持有转交，AppUpdate 接管后负责用毕 close */
  update: Update
}

export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false)
  /** 设置弹窗当前 Tab：支持跨模块直达 */
  const settingsTab = ref<SettingsTabKey>('platforms')
  /** shallowRef：StartupUpdate 携带 Rust 资源类实例（Update），不可被深响应解包 */
  const startupUpdate = shallowRef<PendingUpdateInfo | null>(null)

  function openSettings(tab?: SettingsTabKey): void {
    if (tab) settingsTab.value = tab
    settingsOpen.value = true
  }

  function closeSettings(): void {
    settingsOpen.value = false
  }

  /** 释放未消费的启动检查 Update（评审 10-22 二轮：用户始终不打开「关于」页签时，
   *  该 Rust 侧资源会持有到进程退出——应用卸载时兜底释放） */
  function disposeStartupUpdate(): void {
    const pending = startupUpdate.value
    if (!pending) return
    startupUpdate.value = null
    void pending.update.close().catch(() => {
      /* 释放失败不阻塞 */
    })
  }

  /** 释放并忽略未消费的启动检查 Update：横幅「忽略」按钮调用——清空提示并释放
   *  Rust 侧资源（评审三轮：横幅是唯一入口且无法消除，用户暂时不想升级时得能关掉） */
  function dismissStartupUpdate(): void {
    disposeStartupUpdate()
  }

  return {
    settingsOpen,
    settingsTab,
    startupUpdate,
    openSettings,
    closeSettings,
    disposeStartupUpdate,
    dismissStartupUpdate,
  }
})
