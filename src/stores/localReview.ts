import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { loadJson, persistJson } from '../services/storage'

/** 草稿持久化键：提交说明草稿与上次选中仓库写穿落盘，整页重载（如 WebView2 渲染层恢复）后仍可恢复 */
const DRAFTS_STORAGE_KEY = 'mergehub:local-review:drafts'

/** 持久化的草稿结构 */
interface LocalReviewDrafts {
  /** 上次选中的本地仓库路径 */
  selected: string
  /** 各仓库的提交说明草稿：key 为仓库路径 */
  messages: Record<string, string>
}

/** 从持久化层恢复草稿；缺省或数据损坏时回退为空，不阻断启动 */
function loadDrafts(): LocalReviewDrafts {
  const parsed = loadJson(DRAFTS_STORAGE_KEY) as Partial<LocalReviewDrafts> | null
  if (!parsed) return { selected: '', messages: {} }
  const messages: Record<string, string> = {}
  if (parsed.messages && typeof parsed.messages === 'object') {
    for (const [key, value] of Object.entries(parsed.messages)) {
      // __proto__ 跳过：纵深第二层（第一层 loadJson 源头 stripProtoKey），防止回写触发原型 setter
      if (key === '__proto__') continue
      if (typeof value === 'string') messages[key] = value
    }
  }
  return { selected: typeof parsed.selected === 'string' ? parsed.selected : '', messages }
}

/** 本地审阅工作台的跨路由状态：上移到 Pinia 后不随审阅页组件销毁重建而丢失（如切页期间 AI 生成提交说明完成的结果） */
export const useLocalReviewStore = defineStore('localReview', () => {
  const drafts = loadDrafts()
  /** 当前选中的本地仓库路径（工作台展示对象），空串表示未选择 */
  const selectedLocal = ref(drafts.selected)
  /** 工作台当前 Tab：files / diff / commit / ai */
  const activeTab = ref('files')
  /** 底部提交条是否展开为输入框 */
  const commitBarExpanded = ref(false)
  /** AI 生成提交说明进行中标记 */
  const messageGenerating = ref(false)
  /** 各仓库草稿中的提交说明：key 为仓库路径 */
  const commitMessages = reactive<Record<string, string>>({ ...drafts.messages })

  /** 草稿写穿持久化：任何变更立即落盘，页面级重载后可完整恢复；
   *  持久化失败（如存储配额/隐私模式）不阻断主流程，仅失去跨重载恢复能力，storage 层已留痕 */
  function persistDrafts() {
    const payload: LocalReviewDrafts = { selected: selectedLocal.value, messages: commitMessages }
    persistJson(DRAFTS_STORAGE_KEY, payload)
  }

  /** 选中本地仓库（含清空的空串场景），并同步持久化 */
  function setSelected(path: string) {
    selectedLocal.value = path
    persistDrafts()
  }

  /** 切换工作台 Tab（files / diff / commit / ai） */
  function setActiveTab(tab: string) {
    activeTab.value = tab
  }

  /** 展开（true）或收起（false）底部提交条 */
  function setCommitBarExpanded(expanded: boolean) {
    commitBarExpanded.value = expanded
  }

  /** 标记 AI 生成提交说明进行中状态 */
  function setMessageGenerating(generating: boolean) {
    messageGenerating.value = generating
  }

  /** 写入某仓库的提交说明草稿，并同步持久化；key 为空时拒绝写入，避免静默丢失 */
  function setCommitMessage(key: string, text: string) {
    if (!key) return
    commitMessages[key] = text
    persistDrafts()
  }

  /** 清除某仓库的提交说明草稿（移除仓库/提交成功后），并同步持久化 */
  function clearCommitMessage(key: string) {
    if (!key) return
    delete commitMessages[key]
    persistDrafts()
  }

  return {
    selectedLocal,
    activeTab,
    commitBarExpanded,
    messageGenerating,
    commitMessages,
    setSelected,
    setActiveTab,
    setCommitBarExpanded,
    setMessageGenerating,
    setCommitMessage,
    clearCommitMessage,
  }
})
