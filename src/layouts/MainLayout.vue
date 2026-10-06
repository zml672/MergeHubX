<script setup lang="ts">
import { computed, onMounted, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AppstoreOutlined,
  AuditOutlined,
  BranchesOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons-vue'
import SettingsPanel from '../components/settings/SettingsPanel.vue'
import { useGovernanceIssuesStore } from '../stores/governanceIssues'
import { useLocalReposStore } from '../stores/localRepos'
import { usePrsStore } from '../stores/prs'
import { useUiStore } from '../stores/ui'

const route = useRoute()
const router = useRouter()
const ui = useUiStore()
const prs = usePrsStore()
const localRepos = useLocalReposStore()
const governanceIssues = useGovernanceIssuesStore()

/** 待审阅总数：远程待审 PR 数 + 有变更的本地仓库数（仓库只要有变更即计 1） */
const pendingCount = computed(() => prs.totalOpenCount + localRepos.changeTotal)

onMounted(() => {
  void localRepos.refreshChanges()
})

/** 导航项：count 为可选徽标计数 getter，内聚于条目定义——避免按路由字符串硬编码映射（路径改名或新增带计数导航时易漏改致徽标静默失效），调用时求值以在模板渲染中建立响应式依赖 */
type NavItem = { key: string; label: string; icon: Component; count?: () => number }

const navItems: NavItem[] = [
  { key: '/', label: '总览', icon: AppstoreOutlined },
  { key: '/review', label: '审阅', icon: BranchesOutlined, count: () => pendingCount.value },
  { key: '/governance', label: '治理', icon: AuditOutlined, count: () => governanceIssues.unsedimentedCount },
]

function go(key: string) {
  if (route.path !== key) router.push(key)
}
</script>

<template>
  <a-layout class="app-shell">
    <a-layout-header class="app-header">
      <div class="brand">
        <span class="brand-logo">MH</span>
        <span class="brand-name">MergeHub</span>
      </div>
      <nav class="nav-menu">
          <button
            v-for="item in navItems"
            :key="item.key"
            type="button"
            class="nav-item"
            :class="{ active: route.path === item.key }"
            @click="go(item.key)"
          >
            <a-badge v-if="(item.count?.() ?? 0) > 0" :count="item.count?.() ?? 0" size="small" :offset="[3, -3]">
              <component :is="item.icon" />
            </a-badge>
            <component v-else :is="item.icon" />
            <span>{{ item.label }}</span>
          </button>
        </nav>
      <a-tag color="blue" class="mode-tag">形态 A · 纯客户端</a-tag>
    </a-layout-header>
    <a-layout-content class="app-content">
      <!-- 审阅页路由级保活：切换到其他页面再回来时组件不销毁，进行中的 AI 任务与未提交的编辑状态得以保留 -->
      <router-view v-slot="{ Component }">
        <keep-alive include="ReviewView,GovernanceView">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </a-layout-content>
    <div class="corner-dock" role="toolbar" aria-label="快捷操作">
      <a-tooltip title="设置" placement="left">
        <button type="button" class="dock-btn" aria-label="设置" @click="ui.openSettings()">
          <SettingOutlined />
        </button>
      </a-tooltip>
      <div class="dock-divider" role="separator" />
      <a-tooltip title="登录 / 注册（敬请期待）" placement="left">
        <span class="dock-slot">
          <button type="button" class="dock-btn" aria-label="登录 / 注册（敬请期待）" disabled>
            <UserOutlined />
          </button>
        </span>
      </a-tooltip>
    </div>
    <a-modal
      v-model:open="ui.settingsOpen"
      title="设置"
      :width="'min(960px, calc(100vw - 48px))'"
      :footer="null"
      centered
      destroy-on-close
    >
      <div class="settings-modal-body">
        <SettingsPanel />
      </div>
    </a-modal>
  </a-layout>
</template>

<style scoped>
.app-shell {
  height: 100vh;
}

.app-header {
  height: 48px;
  line-height: normal;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.brand-logo {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: linear-gradient(135deg, #1677ff, #36cfc9);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-name {
  font-weight: 700;
  font-size: 16px;
}

.nav-menu {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.65);
  cursor: pointer;
  transition: background-color 0.2s, color 0.2s;
}

.nav-item:hover {
  background: #f5f5f5;
  color: rgba(0, 0, 0, 0.88);
}

.nav-item.active {
  background: #e6f4ff;
  color: #1677ff;
  font-weight: 500;
}

.nav-item .anticon {
  font-size: 15px;
}

.mode-tag {
  flex-shrink: 0;
}

.app-content {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.settings-modal-body {
  height: min(720px, calc(100vh - 160px));
  overflow: hidden;
}

.corner-dock {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: #fff;
  border: 1px solid rgba(5, 5, 5, 0.06);
  border-radius: 12px;
  box-shadow:
    0 6px 16px rgba(0, 0, 0, 0.08),
    0 1px 2px rgba(0, 0, 0, 0.04);
  animation: dock-in 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes dock-in {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
  }
}

.dock-slot {
  display: inline-flex;
}

.dock-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 16px;
  color: rgba(0, 0, 0, 0.65);
  cursor: pointer;
  transition:
    background-color 0.15s cubic-bezier(0.2, 0, 0, 1),
    color 0.15s cubic-bezier(0.2, 0, 0, 1),
    transform 0.12s cubic-bezier(0.2, 0, 0, 1);
}

.dock-btn:hover:not(:disabled) {
  background: #f5f5f5;
  color: #1677ff;
}

.dock-btn:active:not(:disabled) {
  background: #e6f4ff;
  transform: scale(0.92);
}

.dock-btn:disabled {
  color: rgba(0, 0, 0, 0.22);
  cursor: not-allowed;
}

.dock-btn:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: -2px;
}

.dock-divider {
  height: 1px;
  margin: 0 8px;
  background: rgba(5, 5, 5, 0.06);
}

@media (prefers-reduced-motion: reduce) {
  .corner-dock {
    animation: none;
  }

  .dock-btn {
    transition: none;
  }
}
</style>
