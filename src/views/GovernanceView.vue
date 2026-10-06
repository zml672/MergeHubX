<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GovernanceRecords from '../components/governance/GovernanceRecords.vue'
import RuleSets from '../components/governance/RuleSets.vue'
import { useGovernanceIssuesStore } from '../stores/governanceIssues'

type GovernanceTab = 'exempt' | 'comply' | 'rules'

const route = useRoute()
const router = useRouter()
const governanceIssues = useGovernanceIssuesStore()

const view = computed<GovernanceTab>(() => {
  const v = route.query.view
  return v === 'comply' || v === 'rules' ? v : 'exempt'
})

function switchView(next: GovernanceTab): void {
  if (view.value === next) return
  router.replace({ query: { ...route.query, view: next } })
}
</script>

<template>
  <div class="governance-page">
    <div class="governance-head">
      <h2 class="governance-title">治理工作台</h2>
      <nav class="governance-tabs">
        <button
          type="button"
          class="governance-tab"
          :class="{ active: view === 'exempt' }"
          @click="switchView('exempt')"
        >
          豁免记录
          <span
            v-if="governanceIssues.unsedimentedCountBy('exempt') > 0"
            class="governance-tab-count"
          >{{ governanceIssues.unsedimentedCountBy('exempt') }}</span>
        </button>
        <button
          type="button"
          class="governance-tab"
          :class="{ active: view === 'comply' }"
          @click="switchView('comply')"
        >
          遵守记录
          <span
            v-if="governanceIssues.unsedimentedCountBy('comply') > 0"
            class="governance-tab-count"
          >{{ governanceIssues.unsedimentedCountBy('comply') }}</span>
        </button>
        <button
          type="button"
          class="governance-tab"
          :class="{ active: view === 'rules' }"
          @click="switchView('rules')"
        >
          规范集
        </button>
      </nav>
    </div>
    <div v-show="view === 'exempt'" class="governance-body">
      <GovernanceRecords disposition="exempt" />
    </div>
    <div v-show="view === 'comply'" class="governance-body">
      <GovernanceRecords disposition="comply" />
    </div>
    <div v-show="view === 'rules'" class="governance-body">
      <RuleSets />
    </div>
  </div>
</template>

<style scoped>
.governance-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  overflow: hidden;
}

.governance-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 10px 20px 0;
  border-bottom: 1px solid #f0f0f0;
}

.governance-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.governance-tabs {
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 4px;
}

.governance-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  margin: 0 8px;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.65);
  cursor: pointer;
  transition: color 0.2s;
}

.governance-tab:hover {
  color: #1677ff;
}

.governance-tab.active {
  color: #1677ff;
  font-weight: 500;
}

.governance-tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: #1677ff;
  border-radius: 1px 1px 0 0;
}

.governance-tab:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: -2px;
  border-radius: 4px;
}

.governance-tab-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #ff4d4f;
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  text-align: center;
}

.governance-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px 16px;
}
</style>
