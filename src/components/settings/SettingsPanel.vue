<script setup lang="ts">
import { useRouter } from 'vue-router'
import AiModels from './AiModels.vue'
import LocalGitPrefs from './LocalGitPrefs.vue'
import PlatformAccounts from './PlatformAccounts.vue'
import { useUiStore } from '../../stores/ui'

const ui = useUiStore()
const router = useRouter()

function goGovernance(): void {
  ui.closeSettings()
  router.push('/governance')
}
</script>

<template>
  <a-tabs v-model:activeKey="ui.settingsTab" tab-position="left" class="settings-tabs">
    <a-tab-pane key="platforms" tab="平台接入">
      <PlatformAccounts />
    </a-tab-pane>
    <a-tab-pane key="ai" tab="AI 模型">
      <AiModels />
      <div class="governance-entry">
        <div class="governance-entry-text">
          <span class="governance-entry-title">评审规范与治理记录</span>
          <span class="governance-entry-desc">已迁至治理工作台，独立页面提供更大的操作空间与互相跳转</span>
        </div>
        <a-button size="small" @click="goGovernance">前往治理工作台</a-button>
      </div>
    </a-tab-pane>
    <a-tab-pane key="local" tab="本地仓库">
      <LocalGitPrefs />
    </a-tab-pane>
  </a-tabs>
</template>

<style scoped>
.settings-tabs {
  height: 100%;
}

.settings-tabs :deep(.ant-tabs-content-holder) {
  overflow-y: auto;
}

.governance-entry {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--ant-color-border, #d9d9d9);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.governance-entry-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.governance-entry-title {
  font-size: 13px;
  font-weight: 600;
}

.governance-entry-desc {
  font-size: 12px;
  color: var(--ant-color-text-secondary, rgba(0, 0, 0, 0.45));
}
</style>
