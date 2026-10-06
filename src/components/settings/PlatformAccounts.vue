<script setup lang="ts">
import { onMounted } from 'vue'
import { message } from 'ant-design-vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { providers } from '../../services/platforms'
import { useSettingsStore } from '../../stores/settings'
import { PLATFORMS, PLATFORM_LABELS, type Platform } from '../../types/platform'

const settings = useSettingsStore()

/** 各平台令牌创建页及一句话说明；hostPath 用于自建实例（GHES / 私有化 GitLab）按 Base URL 拼接 */
const PLATFORM_GUIDES: Record<Platform, { url: string; hostPath?: string; tip: string }> = {
  github: {
    url: 'https://github.com/settings/tokens/new?description=MergeHub&scope=repo',
    hostPath: '/settings/tokens/new?description=MergeHub&scope=repo',
    tip: '打开即到创建页，勾选 repo 权限（读 PR 与合并必需），生成后复制令牌粘贴到下方。GitHub Enterprise 先填 Base URL 再点此，将打开你自己的实例。',
  },
  gitlab: {
    url: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=MergeHub&scopes=api',
    hostPath: '/-/user_settings/personal_access_tokens?name=MergeHub&scopes=api',
    tip: '私有化部署先填下方 Base URL 再点此，直达你实例的令牌创建页（已预勾 api）；旧版实例若打不开，改访问 实例地址/profile/personal_access_tokens。',
  },
  gitee: {
    url: 'https://gitee.com/profile/personal_access_tokens/new?name=MergeHub&scopes=projects,pull_requests',
    tip: '打开即到创建页，勾选 projects、pull_requests 权限，生成后复制令牌粘贴到下方。',
  },
}

function openTokenGuide(platform: Platform) {
  const guide = PLATFORM_GUIDES[platform]
  const raw = settings.accounts[platform].baseUrl.trim()
  let target = guide.url
  if (guide.hostPath && raw) {
    let base = raw.replace(/\/+$/, '')
    if (platform === 'github') base = base.replace(/\/api\/v3$/i, '')
    if (platform === 'gitlab') base = base.replace(/\/api\/v4$/i, '')
    target = `${base}${guide.hostPath}`
  }
  void openUrl(target)
}

onMounted(async () => {
  await Promise.all(PLATFORMS.map((p) => settings.loadAccount(p)))
})

async function save(platform: Platform) {
  try {
    await settings.saveAccount(platform)
    message.success(`${PLATFORM_LABELS[platform]} 配置已保存，令牌已存入系统凭据管理器`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div>
    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 16px"
      message="令牌与 API Key 均保存在系统凭据管理器中，不会明文落盘。"
      description="Base URL 仅自建实例需要修改：GitLab 填私有化部署地址（如 https://gitlab.example.com）；GitHub Enterprise Server 填 https://<host>/api/v3；Gitee 固定使用官方地址，无需配置。"
    />
    <a-card
      v-for="p in PLATFORMS"
      :key="p"
      :title="PLATFORM_LABELS[p]"
      style="margin-bottom: 16px"
    >
      <a-form layout="vertical">
        <a-form-item>
          <template #label>
            <span>访问令牌 (Token)</span>
            <a-button type="link" size="small" class="guide-link" @click="openTokenGuide(p)">
              如何获取？
            </a-button>
          </template>
          <a-input-password
            v-model:value="settings.accounts[p].token"
            placeholder="个人访问令牌"
            allow-clear
          />
          <div class="guide-tip">{{ PLATFORM_GUIDES[p].tip }}</div>
        </a-form-item>
        <a-form-item v-if="p !== 'gitee'" label="API Base URL（可选）">
          <a-input
            v-model:value="settings.accounts[p].baseUrl"
            :placeholder="providers[p].defaultBaseUrl"
            allow-clear
          />
        </a-form-item>
        <a-button type="primary" :loading="settings.accounts[p].verifying" @click="save(p)">
          保存
        </a-button>
        <div v-if="settings.accounts[p].verifying" class="verify-line">
          <a-spin size="small" />
          <span>正在验证连接…</span>
        </div>
        <div v-else-if="settings.accounts[p].verifiedName" class="verify-line verify-ok">
          ✓ 已连接：{{ settings.accounts[p].verifiedName }}
        </div>
        <div v-else-if="settings.accounts[p].verifyError" class="verify-line verify-err">
          ✗ {{ settings.accounts[p].verifyError }}
        </div>
      </a-form>
    </a-card>
  </div>
</template>

<style scoped>
.guide-link {
  margin-left: 8px;
  padding: 0;
  font-size: 12px;
}
.guide-tip {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #999;
}
.verify-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}
.verify-ok {
  color: #389e0d;
}
.verify-err {
  color: #cf1322;
  word-break: break-all;
}
</style>
