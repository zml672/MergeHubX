<script setup lang="ts">
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { FolderOpenOutlined } from '@ant-design/icons-vue'
import { lastLogPath, openAiLogDir } from '../../services/aiDebugLog'

const opening = ref(false)

/** 打开日志所在文件夹 */
async function openDir(): Promise<void> {
  opening.value = true
  try {
    await openAiLogDir()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <div class="debug-panel">
    <div class="debug-head">
      <span class="debug-title">AI 调试日志</span>
      <a-button size="small" :loading="opening" @click="openDir">
        <template #icon><FolderOpenOutlined /></template>
        打开所在文件夹
      </a-button>
    </div>
    <p class="debug-hint">
      每次 AI 评审与豁免/遵守归纳的完整提示词及响应会写入本地日志文件（按仓库每天一份，保留
      15 天后循环清除），用于追溯实际发送给模型的内容。
    </p>
    <div v-if="lastLogPath" class="debug-path">{{ lastLogPath }}</div>
    <div v-else class="debug-empty">暂无日志：运行一次 AI 评审后，这里会显示日志文件路径。</div>
  </div>
</template>

<style scoped>
.debug-panel {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid rgba(5, 5, 5, 0.08);
}

.debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.debug-title {
  font-size: 13px;
  font-weight: 600;
}

.debug-hint {
  margin: 0 0 10px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.5;
}

.debug-path {
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 8px;
  color: rgba(0, 0, 0, 0.65);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.debug-empty {
  padding: 12px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  text-align: center;
  border: 1px dashed rgba(5, 5, 5, 0.15);
  border-radius: 8px;
}
</style>
