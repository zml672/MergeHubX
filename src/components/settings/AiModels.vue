<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { openUrl } from '@tauri-apps/plugin-opener'
import { friendlyAiError, testAiConnection } from '../../services/ai'
import { useAiStore } from '../../stores/ai'
import { AI_PRESETS, aiPresetOf, type AiModelProfile } from '../../types/ai'
import AiDebugLog from './AiDebugLog.vue'

const ai = useAiStore()

const presetOptions = AI_PRESETS.map((p) => ({ label: p.label, value: p.id }))

const formOpen = ref(false)
const editingId = ref<string | null>(null)
const testing = ref(false)
const form = reactive({
  name: '',
  presetId: 'deepseek',
  baseUrl: '',
  model: '',
  apiKey: '',
  concurrency: 2,
})
let snapshot = ''

onMounted(() => {
  void ai.load()
})

const formPreset = computed(() => aiPresetOf(form.presetId))

const presetId = computed({
  get: () => form.presetId,
  set: (value: string) => {
    form.presetId = value
    const preset = aiPresetOf(value)
    if (preset.baseUrl) form.baseUrl = preset.baseUrl
    if (preset.defaultModel) form.model = preset.defaultModel
  },
})

function snapshotForm(): string {
  return JSON.stringify({ ...form })
}

function openAdd() {
  editingId.value = null
  form.name = ''
  form.presetId = 'deepseek'
  form.baseUrl = ''
  form.model = ''
  form.apiKey = ''
  form.concurrency = 2
  snapshot = snapshotForm()
  formOpen.value = true
}

function openEdit(profile: AiModelProfile) {
  editingId.value = profile.id
  form.name = profile.name
  form.presetId = profile.presetId
  form.baseUrl = profile.baseUrl
  form.model = profile.model
  form.apiKey = ai.apiKeyMap[profile.id] ?? ''
  form.concurrency = profile.concurrency ?? 2
  snapshot = snapshotForm()
  formOpen.value = true
}

function handleCancel() {
  if (snapshotForm() !== snapshot) {
    Modal.confirm({
      title: '放弃修改？',
      content: '当前模型档案的修改尚未保存。',
      okText: '放弃修改',
      okType: 'danger',
      cancelText: '继续编辑',
      onOk: () => {
        formOpen.value = false
      },
    })
    return
  }
  formOpen.value = false
}

async function submitProfile() {
  if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
    message.warning('档案名称、Base URL 与模型名称不能为空')
    return
  }
  let saved: AiModelProfile
  try {
    saved = ai.upsertProfile(
      {
        id: editingId.value ?? undefined,
        name: form.name,
        presetId: form.presetId,
        baseUrl: form.baseUrl,
        model: form.model,
        concurrency: form.concurrency,
      },
      form.apiKey,
    )
  } catch (err) {
    message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    return
  }
  formOpen.value = false
  if (editingId.value === null) {
    ai.setActiveProfile(saved.id)
    message.success(`模型档案「${saved.name}」已保存并启用`)
  } else {
    message.success('模型档案已保存')
  }
}

async function testConnection() {
  if (!form.baseUrl.trim() || !form.model.trim()) {
    message.warning('请先填写 Base URL 与模型名称')
    return
  }
  testing.value = true
  try {
    const reply = await testAiConnection({
      baseUrl: form.baseUrl,
      model: form.model,
      apiKey: form.apiKey,
    })
    message.success(`连接成功，模型回复：${reply.slice(0, 40)}`)
  } catch (err) {
    message.error(friendlyAiError(err))
  } finally {
    testing.value = false
  }
}

async function openKeyUrl() {
  const url = formPreset.value.keyUrl
  if (!url) return
  try {
    await openUrl(url)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function useProfile(profile: AiModelProfile) {
  ai.setActiveProfile(profile.id)
  message.success(`已切换为使用「${profile.name}」`)
}

function removeProfile(profile: AiModelProfile) {
  const isActive = profile.id === ai.activeProfileId
  ai.removeProfile(profile.id)
  message.success(isActive ? '已删除并切换到首个模型档案' : '已删除该模型档案')
}
</script>

<template>
  <div>
    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 16px"
      message="模型档案相互独立，切换模型不会覆盖其他档案的配置。"
      description="「使用中」的档案将用于 AI 评审；可保存多套模型（如云端 DeepSeek 与本地 Ollama）随时切换。"
    />
    <div class="profiles-toolbar">
      <a-button type="primary" @click="openAdd">新增模型档案</a-button>
    </div>
    <div class="profile-list">
      <div
        v-for="p in ai.profiles"
        :key="p.id"
        class="profile-row"
        :class="{ active: p.id === ai.activeProfileId }"
      >
        <div class="profile-main">
          <div class="profile-name">
            <span>{{ p.name }}</span>
            <a-tag v-if="p.id === ai.activeProfileId" color="success">使用中</a-tag>
          </div>
          <div class="profile-meta" :title="`${p.model} · ${p.baseUrl}`">
            {{ aiPresetOf(p.presetId).label }} · {{ p.model || '未配置模型' }}
          </div>
        </div>
        <div class="profile-actions">
          <a-button
            v-if="p.id !== ai.activeProfileId"
            size="small"
            type="primary"
            @click="useProfile(p)"
          >
            使用
          </a-button>
          <a-button size="small" @click="openEdit(p)">编辑</a-button>
          <a-popconfirm
            v-if="ai.profiles.length > 1"
            title="确认删除该模型档案？"
            @confirm="removeProfile(p)"
          >
            <a-button size="small" danger>删除</a-button>
          </a-popconfirm>
        </div>
      </div>
    </div>

    <a-modal
      :open="formOpen"
      :title="editingId ? '编辑模型档案' : '新增模型档案'"
      :width="560"
      ok-text="保存"
      cancel-text="取消"
      @cancel="handleCancel"
      @ok="submitProfile"
    >
      <a-form layout="vertical">
        <a-form-item label="档案名称" required>
          <a-input
            v-model:value="form.name"
            placeholder="例如：DeepSeek 主力 / 本地 Ollama"
            allow-clear
          />
        </a-form-item>
        <a-form-item label="模型预设">
          <a-select v-model:value="presetId" :options="presetOptions" />
        </a-form-item>
        <a-form-item label="API Base URL" required>
          <a-input
            v-model:value="form.baseUrl"
            :placeholder="formPreset.baseUrl || 'https://api.example.com/v1'"
            allow-clear
          />
        </a-form-item>
        <a-form-item label="模型名称" required>
          <a-input
            v-model:value="form.model"
            :placeholder="formPreset.defaultModel || '例如 gpt-4o-mini'"
            allow-clear
          />
        </a-form-item>
        <a-form-item v-if="formPreset.needsKey" label="API Key">
          <a-input-password
            v-model:value="form.apiKey"
            placeholder="模型服务 API Key"
            allow-clear
          />
        </a-form-item>
        <a-form-item v-else>
          <a-alert type="success" show-icon message="本地模型无需 API Key" />
        </a-form-item>
        <a-form-item
          label="批次并发数"
          extra="同时评审的批次数（1-6），调大可缩短总耗时；过大易触发 API 限流，限流时会自动等待重试。建议 1-3。"
        >
          <a-input-number v-model:value="form.concurrency" :min="1" :max="6" :precision="0" />
        </a-form-item>
        <div class="form-actions">
          <a-button :loading="testing" @click="testConnection">测试连接</a-button>
          <a-button v-if="formPreset.keyUrl" type="link" @click="openKeyUrl">
            获取 API Key ↗
          </a-button>
        </div>
      </a-form>
    </a-modal>

    <AiDebugLog />
  </div>
</template>

<style scoped>
.profiles-toolbar {
  margin-bottom: 12px;
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.profile-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(5, 5, 5, 0.08);
  border-radius: 8px;
}

.profile-row.active {
  border-color: var(--ant-color-success, #52c41a);
  background: rgba(82, 196, 26, 0.06);
}

.profile-main {
  flex: 1;
  min-width: 0;
}

.profile-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.profile-meta {
  overflow: hidden;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.profile-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
