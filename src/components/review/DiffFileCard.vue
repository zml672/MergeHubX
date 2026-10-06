<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { DownOutlined } from '@ant-design/icons-vue'
import type { DiffFile, DiffFileStatus } from '../../types/platform'

const props = defineProps<{
  file: DiffFile
  platformLabel?: string
  /** 是否显示勾选框：本地工作区提交模式传入，远程详情不传即无勾选 */
  selectable?: boolean
  /** 勾选态由父组件受控 */
  checked?: boolean
}>()

const emit = defineEmits<{ 'toggle-check': [] }>()

const expanded = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const statusMeta: Record<DiffFileStatus, { color: string; label: string }> = {
  added: { color: 'green', label: '新增' },
  modified: { color: 'blue', label: '修改' },
  removed: { color: 'red', label: '删除' },
  renamed: { color: 'purple', label: '重命名' },
}

interface DiffRow {
  type: 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  oldNo: number
  newNo: number
}

const rows = computed<DiffRow[]>(() => {
  if (!props.file.patch) return []
  const result: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of props.file.patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      result.push({ type: 'hunk', text: raw, oldNo: 0, newNo: 0 })
    } else if (raw.startsWith('+')) {
      result.push({ type: 'add', text: raw.slice(1), oldNo: 0, newNo })
      newNo += 1
    } else if (raw.startsWith('-')) {
      result.push({ type: 'del', text: raw.slice(1), oldNo, newNo: 0 })
      oldNo += 1
    } else {
      result.push({
        type: 'ctx',
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
        oldNo,
        newNo,
      })
      oldNo += 1
      newNo += 1
    }
  }
  return result
})

/** 空态文案按场景区分：无文本变更（二进制等）与平台未返回差异内容（引导配置令牌） */
const emptyHint = computed(() => {
  if (Number(props.file.additions) === 0 && Number(props.file.deletions) === 0) {
    return '该文件没有可预览的差异（可能为二进制文件或无文本变更）'
  }
  const label = props.platformLabel ? `（${props.platformLabel}）` : ''
  return `${label}平台未返回差异内容，建议在设置中配置访问令牌后重试`
})

/**
 * 展开 diff 并滚动定位到新文件的指定行（供父组件在 AI 问题/修复对比跳转时调用）。
 * 若 diff 中不存在该精确行号（如目标行为删除行），定位到它之前最后一个有新行号的行。
 */
async function revealLine(line: number) {
  expanded.value = true
  await nextTick()
  const root = rootRef.value
  if (!root) return
  const lineRows = root.querySelectorAll<HTMLElement>('.diff-row[data-new-line]')
  let found: HTMLElement | null = null
  for (const row of lineRows) {
    if (Number(row.dataset.newLine) >= line) {
      found = row
      break
    }
    found = row
  }
  if (!found) return
  const target = found
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  target.classList.remove('line-flash')
  void target.offsetWidth
  target.classList.add('line-flash')
  window.setTimeout(() => target.classList.remove('line-flash'), 1600)
}

defineExpose({ revealLine })
</script>

<template>
  <div ref="rootRef" class="diff-card">
    <div
      class="diff-head"
      role="button"
      tabindex="0"
      @click="expanded = !expanded"
      @keydown.enter="expanded = !expanded"
    >
      <a-checkbox
        v-if="selectable"
        class="diff-check"
        :checked="checked"
        @click.stop
        @change="emit('toggle-check')"
      />
      <DownOutlined class="diff-caret" :class="{ collapsed: !expanded }" />
      <a-tag :color="statusMeta[file.status].color" class="diff-status">
        {{ statusMeta[file.status].label }}
      </a-tag>
      <span class="diff-path" :title="file.path">{{ file.path }}</span>
      <span class="diff-nums">
        <span class="num-add">+{{ file.additions }}</span>
        <span class="num-del">-{{ file.deletions }}</span>
      </span>
    </div>
    <div v-if="expanded" class="diff-body">
      <div v-if="rows.length === 0" class="diff-empty">
        {{ emptyHint }}
      </div>
      <div v-else class="diff-table">
        <div
          v-for="(row, i) in rows"
          :key="i"
          class="diff-row"
          :class="row.type"
          :data-new-line="row.newNo > 0 ? row.newNo : undefined"
        >
          <span class="cell no">{{ row.oldNo || '' }}</span>
          <span class="cell no">{{ row.newNo || '' }}</span>
          <span class="cell code">{{ row.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-card {
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  overflow: hidden;
}

.diff-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: #fafafa;
  cursor: pointer;
  text-align: left;
}

.diff-check {
  flex-shrink: 0;
  align-items: center;
}

.diff-head:hover {
  background: #f5f5f5;
}

.diff-caret {
  font-size: 10px;
  color: #8c8c8c;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.diff-caret.collapsed {
  transform: rotate(-90deg);
}

.diff-status {
  flex-shrink: 0;
  margin: 0;
}

.diff-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.85);
}

.diff-nums {
  flex-shrink: 0;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  display: flex;
  gap: 8px;
}

.num-add {
  color: #52c41a;
}

.num-del {
  color: #ff4d4f;
}

.diff-body {
  overflow-x: auto;
  border-top: 1px solid #f0f0f0;
}

.diff-empty {
  padding: 16px;
  color: #8c8c8c;
  font-size: 12px;
}

.diff-table {
  min-width: 100%;
  width: max-content;
}

.diff-row {
  position: relative;
  display: flex;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 20px;
}

.diff-row.line-flash::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: row-flash 1.6s ease-out;
}

@keyframes row-flash {
  0%,
  55% {
    background: rgba(250, 173, 20, 0.22);
    box-shadow: inset 3px 0 0 #faad14;
  }

  100% {
    background: transparent;
    box-shadow: none;
  }
}

.cell.no {
  flex: 0 0 48px;
  padding-right: 8px;
  text-align: right;
  color: #bfbfbf;
  user-select: none;
  background: #fafafa;
  border-right: 1px solid #f0f0f0;
}

.cell.code {
  white-space: pre;
  padding: 0 12px;
}

.diff-row.add .cell.no {
  background: #ccffd8;
}

.diff-row.add .cell.code {
  background: #e6ffec;
}

.diff-row.del .cell.no {
  background: #ffd7d9;
}

.diff-row.del .cell.code {
  background: #ffebe9;
}

.diff-row.hunk,
.diff-row.hunk .cell.no {
  background: #f0f5ff;
  color: #1d39c4;
}
</style>
