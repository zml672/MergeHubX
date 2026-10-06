<script setup lang="ts">
import { onMounted } from 'vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import MainLayout from './layouts/MainLayout.vue'
import { useAiStore } from './stores/ai'
import { usePrsStore } from './stores/prs'
import { useSettingsStore } from './stores/settings'
import { PLATFORMS } from './types/platform'

dayjs.locale('zh-cn')

const settings = useSettingsStore()
const prs = usePrsStore()
const ai = useAiStore()

onMounted(async () => {
  await Promise.all([ai.load(), settings.loadPushPrefs(), ...PLATFORMS.map((p) => settings.loadAccount(p))])
  prs.startPolling()
})
</script>

<template>
  <a-config-provider :locale="zhCN">
    <MainLayout />
  </a-config-provider>
</template>
