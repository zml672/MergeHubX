import { defineStore } from 'pinia'
import { ref } from 'vue'

export type SettingsTabKey = 'platforms' | 'ai' | 'local'

export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false)
  /** 设置弹窗当前 Tab：支持跨模块直达 */
  const settingsTab = ref<SettingsTabKey>('platforms')

  function openSettings(tab?: SettingsTabKey): void {
    if (tab) settingsTab.value = tab
    settingsOpen.value = true
  }

  function closeSettings(): void {
    settingsOpen.value = false
  }

  return { settingsOpen, settingsTab, openSettings, closeSettings }
})
