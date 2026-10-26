<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { message, Modal } from 'ant-design-vue'
import { FolderOpenOutlined, SaveOutlined } from '@ant-design/icons-vue'

interface DataRootInfo {
  path: string
  degraded: boolean
  /** 降级原因（degraded 时携带）：unreachable=目录暂不可达；pointerCorrupt=root.json 损坏 */
  reason?: 'unreachable' | 'pointerCorrupt'
  hasCustom: boolean
  defaultPath: string
}

const info = ref<DataRootInfo | null>(null)
const changing = ref(false)

async function refresh(): Promise<void> {
  try {
    info.value = await invoke<DataRootInfo>('data_root_info')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => {
  void refresh()
})

/** 更改存储位置：确认 → dialog 选目录 → 复制数据 → 更新指针 → 提示重启生效。
 *  动态导入与对话框调用一并纳入 try：导入失败/取消选目录都要复位 changing 并给提示。
 *  存储状态未知（info 为 null：加载失败或尚未返回）时同样拦截——迁移前必须确认当前
 *  状态正常，否则可能在降级目录上发起迁移（Rust 侧有守门，此为前端防御纵深） */
async function changeLocation(): Promise<void> {
  if (!info.value) {
    message.warning('存储状态尚未获取，请稍候重试；若持续失败请重启应用')
    return
  }
  if (info.value.degraded) {
    message.warning(
      info.value.reason === 'pointerCorrupt'
        ? '数据根指针文件（root.json）已损坏，请按下方提示处理后重启应用，再更改存储位置'
        : '当前自定义存储位置不可达（数据正写默认位置），请先恢复该目录或重启应用后再更改',
    )
    return
  }
  Modal.confirm({
    title: '更改数据存储位置？',
    content: h('div', [
      h('p', '数据目录将整体复制到新位置（数据量大时需要等待）。'),
      h('p', '迁移期间评审与设置写入会暂时暂停，完成后需重启应用生效。'),
    ]),
    okText: '继续',
    cancelText: '取消',
    onOk: async () => {
      changing.value = true
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const picked = await open({ directory: true, multiple: false })
        if (typeof picked !== 'string' || !picked) return
        const newPath = await invoke<string>('data_root_set', { newRoot: picked })
        Modal.success({
          title: '存储位置已更新',
          content: h('div', [
            h('p', `数据已复制到：${newPath}`),
            h('p', '重启应用后生效（当前会话继续写旧位置，重启前请勿删除旧目录）。'),
          ]),
          okText: '知道了',
        })
        await refresh()
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
      } finally {
        changing.value = false
      }
    },
  })
}

/** 打开数据目录（Rust 侧 opener，免扩前端权限） */
async function openDir(): Promise<void> {
  try {
    await invoke('data_dir_open')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="storage-panel">
    <div class="storage-head">
      <span class="storage-title">数据存储位置</span>
      <div class="storage-actions">
        <a-button size="small" @click="openDir">
          <template #icon><FolderOpenOutlined /></template>
          打开数据目录
        </a-button>
        <a-button size="small" :loading="changing" @click="changeLocation">
          <template #icon><SaveOutlined /></template>
          更改位置
        </a-button>
      </div>
    </div>
    <p class="storage-hint">
      全部评审数据、规则集、治理记录与对话日志以明文 JSON 文件保存在本地，直接复制数据目录
      即为完整备份。更改位置后数据会自动迁移到新目录。
    </p>
    <div v-if="info" class="storage-path">{{ info.path }}</div>
    <a-alert
      v-if="info?.degraded && info.reason === 'pointerCorrupt'"
      type="error"
      show-icon
      class="storage-alert"
      message="数据根指针文件已损坏，已临时回退默认位置"
      :description="`root.json 内容无法解析（可能被手工编辑或写入中断），数据正读写默认位置：${info?.defaultPath}。请勿手工编辑该文件；删除应用数据目录下的 root.json 后重启应用即可恢复默认配置。`"
    />
    <a-alert
      v-else-if="info?.degraded"
      type="warning"
      show-icon
      class="storage-alert"
      message="自定义存储位置当前不可达，已临时回退默认位置"
      :description="`指针指向的自定义目录暂不可用（U 盘未接入或网络盘未挂载），数据正读写默认位置：${info?.defaultPath}。目录恢复后重启应用即自动切回。`"
    />
    <p class="storage-note">重启应用后生效；迁移过程不会删除旧位置数据。</p>
  </div>
</template>

<style scoped>
.storage-panel {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid rgba(5, 5, 5, 0.08);
}

.storage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.storage-title {
  font-size: 13px;
  font-weight: 600;
}

.storage-actions {
  display: flex;
  gap: 8px;
}

.storage-hint {
  margin: 0 0 10px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.5;
}

.storage-path {
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 8px;
  color: rgba(0, 0, 0, 0.65);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.storage-alert {
  margin-top: 10px;
}

.storage-note {
  margin: 8px 0 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
</style>
