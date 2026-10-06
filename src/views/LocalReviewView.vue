<script setup lang="ts">
import { storeToRefs } from 'pinia'
import {
  computed,
  h,
  nextTick,
  onActivated,
  onDeactivated,
  onUnmounted,
  reactive,
  ref,
} from 'vue'
import { useRoute } from 'vue-router'
import { Empty, Modal, message } from 'ant-design-vue'
import dayjs from 'dayjs'
import {
  BranchesOutlined,
  CheckOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  UploadOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons-vue'
import { open } from '@tauri-apps/plugin-dialog'
import AiReportPanel from '../components/review/AiReportPanel.vue'
import CommitButton from '../components/review/CommitButton.vue'
import DiffFileCard from '../components/review/DiffFileCard.vue'
import ReviewModeModal from '../components/review/ReviewModeModal.vue'
import { useAiReviewFlow } from '../composables/useAiReviewFlow'
import { reviewGroupOptions, useReviewGroup } from '../composables/useReviewGroup'
import { friendlyAiError, generateCommitMessage, type AiReviewMode } from '../services/ai'
import { checkoutBranch, commitChanges, getLocalDiff, getRepoInfo, listBranches, listRemotes, pushCommits } from '../services/local/git'
import { openInFileManager } from '../services/local/system'
import { buildLocalReviewDetail, localResultKey, useAiStore } from '../stores/ai'
import { useLocalReposStore } from '../stores/localRepos'
import { useLocalReviewStore } from '../stores/localReview'
import { useSettingsStore, type PushTarget } from '../stores/settings'
import type { GitRemote, LocalBranch, LocalDiffFile, LocalRepoInfo } from '../types/local'
import '../styles/review-shared.css'

const aiStore = useAiStore()
const localRepos = useLocalReposStore()
const localReviewStore = useLocalReviewStore()
const settingsStore = useSettingsStore()
// 选中仓库、Tab、提交条展开态、生成中标记、提交说明草稿存于 Pinia（草稿与选中仓库写穿持久化）：切页销毁重建、整页重载后均不丢
const { selectedLocal, activeTab, commitBarExpanded, messageGenerating } = storeToRefs(localReviewStore)
// 推送目标策略设置项（same-name=同名硬指定；ask=每次询问）从设置 store 读取
const { pushMode } = storeToRefs(settingsStore)
const commitMessages = localReviewStore.commitMessages

const route = useRoute()

const { activeGroup } = useReviewGroup()

/** 本地仓库概要缓存：key 为仓库路径 */
const localInfos = reactive<Record<string, LocalRepoInfo>>({})
/** 本地工作区变更文件缓存：key 为仓库路径 */
const localDiffs = reactive<Record<string, LocalDiffFile[]>>({})
/** 本地分支列表缓存：key 为仓库路径 */
const localBranches = reactive<Record<string, LocalBranch[]>>({})
/** 本地仓库远程列表缓存：key 为仓库路径 */
const localRemotes = reactive<Record<string, GitRemote[]>>({})
/** 会话内手动选择的推送远程：key 为仓库路径（不持久化，仅当前会话生效） */
const selectedRemotes = reactive<Record<string, string>>({})
/** 各仓库勾选的变更文件集合：key 为仓库路径 */
const checkedFiles = reactive<Record<string, Set<string>>>({})
/** 本地仓库加载态：key 为仓库路径 */
const localLoading = reactive<Record<string, boolean>>({})
/** 本地仓库错误信息：key 为仓库路径 */
const localErrors = reactive<Record<string, string>>({})
/** 提交进行中标记（工作台底部提交按钮） */
const localCommitting = ref(false)
/** 分支切换进行中标记 */
const branchSwitching = ref(false)
/** 推送进行中标记（独立推送按钮） */
const localPushing = ref(false)
/** 推送目标询问对话框可见性（受控模式：校验不过时不关闭） */
const pushDialogVisible = ref(false)
/** 推送目标询问对话框中的远端分支输入值 */
const pushDialogRemote = ref('')
/** 推送目标询问对话框中选择的远程仓库名 */
const pushDialogRemoteName = ref('')
/** 对话框场景：commit-push=提交并推送前的目标确认；push-only=仅推送 */
const pushDialogScene = ref<'commit-push' | 'push-only'>('commit-push')

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

/** 弹出系统目录选择框添加本地仓库，成功后自动选中并加载工作区变更 */
async function addLocalRepo() {
  const dir = await open({ directory: true, title: '选择本地仓库目录' })
  if (typeof dir !== 'string' || !dir) return
  if (!localRepos.add(dir)) {
    message.info('该本地仓库已在列表中')
    selectLocalRepo(dir)
    return
  }
  message.success('已添加本地仓库')
  await selectLocalRepo(dir)
}

/** 用系统文件管理器打开本地仓库所在文件夹 */
async function openLocalFolder(path: string) {
  try {
    await openInFileManager(path)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** 选中本地仓库并在工作台展示其待提交变更；force 强制刷新 */
async function selectLocalRepo(path: string, force = false) {
  localReviewStore.setSelected(path)
  await loadLocalRepo(path, force)
}

/** 合并出新的勾选集合：已勾选的文件保留勾选，新出现的文件默认勾选，已消失的文件自然移除 */
function mergeChecked(path: string, prev: LocalDiffFile[] | undefined, diffs: LocalDiffFile[]): Set<string> {
  const checked = checkedFiles[path] ?? new Set<string>()
  const prevPaths = new Set((prev ?? []).map((f) => f.path))
  return new Set(
    diffs
      .filter((f) => checked.has(f.path) || !prevPaths.has(f.path))
      .map((f) => f.path),
  )
}

/** 仓库是否仍在管理列表：异步加载回调写回缓存前的守卫，防止加载期间仓库被移除后缓存与侧栏计数复活驻留 */
function isRepoTracked(path: string): boolean {
  return localRepos.repos.some((r) => r.path === path)
}

/** 加载本地仓库概要与工作区变更文件；默认有缓存时跳过；勾选集合保留已勾选文件、新文件默认勾选，不整体重置 */
async function loadLocalRepo(path: string, force = false) {
  if (localLoading[path]) return
  if (!force && localDiffs[path]) return
  localLoading[path] = true
  localErrors[path] = ''
  try {
    const [info, diffs, branches, remotes] = await Promise.all([
      getRepoInfo(path),
      getLocalDiff(path),
      listBranches(path),
      listRemotes(path),
    ])
    if (!isRepoTracked(path)) return
    localInfos[path] = info
    localBranches[path] = branches
    localRemotes[path] = remotes
    checkedFiles[path] = mergeChecked(path, localDiffs[path], diffs)
    localDiffs[path] = diffs
    // 工作台加载已验证仓库可用，经 store action 同步侧栏角标计数并清除后台统计的过时错误
    localRepos.syncChangeStats(path, diffs.length)
  } catch (err) {
    if (!isRepoTracked(path)) return
    localErrors[path] = err instanceof Error ? err.message : String(err)
  } finally {
    localLoading[path] = false
  }
}

/** 移除本地仓库并清理对应缓存；若正在工作台查看则清空选中 */
function removeLocalRepo(path: string) {
  localRepos.remove(path)
  delete localInfos[path]
  delete localDiffs[path]
  delete localBranches[path]
  delete localRemotes[path]
  delete selectedRemotes[path]
  delete checkedFiles[path]
  localReviewStore.clearCommitMessage(path)
  delete localErrors[path]
  if (selectedLocal.value === path) localReviewStore.setSelected('')
}

/** 当前工作台展示的变更文件列表 */
const localFileList = computed<LocalDiffFile[]>(() =>
  selectedLocal.value ? localDiffs[selectedLocal.value] ?? [] : [],
)
/** 提交按钮禁用态：无待提交变更时禁用（header 与提交条折叠/展开态共用） */
const commitDisabled = computed(() => localFileList.value.length === 0)
/** 当前工作台仓库的概要信息 */
const localInfo = computed<LocalRepoInfo | null>(() =>
  selectedLocal.value ? localInfos[selectedLocal.value] ?? null : null,
)
/** 当前仓库勾选的文件集合（整体替换保证响应式） */
const currentChecked = computed<Set<string>>({
  get: () => checkedFiles[selectedLocal.value] ?? new Set(),
  set: (next) => {
    if (selectedLocal.value) checkedFiles[selectedLocal.value] = next
  },
})
/** 勾选的变更文件数量 */
const checkedCount = computed(() => currentChecked.value.size)
/** 是否全部勾选 */
const allChecked = computed(
  () => localFileList.value.length > 0 && checkedCount.value === localFileList.value.length,
)
/** 半选态（部分勾选） */
const someChecked = computed(() => checkedCount.value > 0 && !allChecked.value)
/** 当前仓库变更行数统计 */
const localAdditions = computed(() => localFileList.value.reduce((sum, f) => sum + f.additions, 0))
const localDeletions = computed(() => localFileList.value.reduce((sum, f) => sum + f.deletions, 0))
/** 提交说明草稿的双向绑定 */
const currentCommitMessage = computed<string>({
  get: () => commitMessages[selectedLocal.value] ?? '',
  set: (next) => {
    if (selectedLocal.value) localReviewStore.setCommitMessage(selectedLocal.value, next)
  },
})
/** 当前仓库名（左侧列表与工作台标题共用） */
const selectedLocalName = computed(
  () => localRepos.repos.find((r) => r.path === selectedLocal.value)?.name ?? '',
)
/** 同名硬指定的推送目标：当前分支名即远端分支名（游离 HEAD 时空，不允许推送） */
const sameNameTarget = computed(() => {
  const branch = localInfo.value?.branch ?? ''
  return branch && branch !== 'HEAD' ? branch : ''
})
/** 当前仓库的推送目标记忆（无记录时给空结构兜底） */
const currentPushTargets = computed(
  () => settingsStore.pushTargets[selectedLocal.value] ?? { last: null, list: [] },
)
/** 当前仓库的远程列表 */
const currentRemotes = computed<GitRemote[]>(() =>
  selectedLocal.value ? localRemotes[selectedLocal.value] ?? [] : [],
)
/** 当前生效的推送远程：手动选择 > 上次推送记忆（仍在列表中）> origin > 列表首个 > 空（无远程，推送前拦截） */
const currentPushRemote = computed(() => {
  const remotes = currentRemotes.value
  if (remotes.length === 0) return ''
  const manual = selectedRemotes[selectedLocal.value]
  if (manual && remotes.some((r) => r.name === manual)) return manual
  const lastRemote = currentPushTargets.value.last?.remote
  if (lastRemote && remotes.some((r) => r.name === lastRemote)) return lastRemote
  if (remotes.some((r) => r.name === 'origin')) return 'origin'
  return remotes[0].name
})
/** 当前生效推送远程的推送地址（已剔除内嵌凭证） */
const currentPushRemoteUrl = computed(
  () => currentRemotes.value.find((r) => r.name === currentPushRemote.value)?.pushUrl ?? '',
)
/** 推送目标标签悬浮说明 */
const pushTagTitle = computed(() => {
  if (currentRemotes.value.length === 0) return '当前仓库未配置远程仓库，推送不可用'
  const base = `推送目标：${currentPushRemote.value}（${currentPushRemoteUrl.value || '地址未知'}）`
  return currentRemotes.value.length > 1 ? `${base}；点击切换推送远程` : base
})
/** 提交&推送按钮悬浮说明：按生效远程动态生成 */
const commitButtonTip = computed(() =>
  currentRemotes.value.length === 0
    ? '当前仓库未配置远程仓库，可下拉选择「仅提交」'
    : `把勾选的变更文件提交到本地仓库并推送到 ${currentPushRemote.value}；下拉可选仅提交`,
)
/** 独立推送按钮悬浮说明：按生效远程动态生成 */
const pushOnlyTip = computed(() =>
  currentRemotes.value.length === 0
    ? '当前仓库未配置远程仓库，推送不可用'
    : `把当前分支领先远端的提交推送到 ${currentPushRemote.value}`,
)
/** 询问对话框远程下拉候选 */
const pushRemoteOptions = computed(() =>
  currentRemotes.value.map((r) => ({ value: r.name, label: r.name })),
)
/** 询问对话框中选中远程的推送地址（展示在远程下拉下方） */
const pushDialogRemoteUrl = computed(
  () => currentRemotes.value.find((r) => r.name === pushDialogRemoteName.value)?.pushUrl ?? '',
)
/** 询问对话框候选：历史记录在前（value 按分支唯一化，同分支多远程保留最新一条），同名分支不在历史时追加在后 */
const pushDialogOptions = computed(() => {
  const options: { value: string; remote: string }[] = []
  for (const item of currentPushTargets.value.list) {
    if (!options.some((o) => o.value === item.branch)) options.push({ value: item.branch, remote: item.remote })
  }
  const branch = sameNameTarget.value
  if (branch && !options.some((o) => o.value === branch)) options.push({ value: branch, remote: '' })
  return options
})
/** 防呆提示：输入的分支名既非同名分支、也不在当前所选远程的历史记录中，推送时将在远端自动创建（不阻断） */
const pushDialogCreateHint = computed(() => {
  const name = pushDialogRemote.value.trim()
  if (!name || name === sameNameTarget.value || currentPushTargets.value.list.some((t) => t.branch === name && t.remote === pushDialogRemoteName.value)) return ''
  return `分支 ${name} 不在历史记录中，推送时将在远端自动创建`
})

/** 勾选/取消勾选单个变更文件 */
function toggleLocalFile(path: string, checked: boolean) {
  const next = new Set(currentChecked.value)
  if (checked) next.add(path)
  else next.delete(path)
  currentChecked.value = next
}

/** 全选/取消全选所有变更文件 */
function onToggleAllFiles(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  currentChecked.value = checked ? new Set(localFileList.value.map((f) => f.path)) : new Set()
}

/** 工作区变更状态到标签的展示映射（提交页文件列表使用；diff 详情页由 DiffFileCard 自行渲染） */
const LOCAL_STATUS_META: Record<LocalDiffFile['status'], { color: string; label: string }> = {
  added: { color: 'success', label: '新增' },
  modified: { color: 'processing', label: '修改' },
  removed: { color: 'error', label: '删除' },
  renamed: { color: 'purple', label: '重命名' },
}

/** 提交页文件行的勾选事件 */
function onCommitFileCheck(path: string, e: Event) {
  toggleLocalFile(path, (e.target as HTMLInputElement).checked)
}

/** 提交前置引导：未完成勾选/说明时切到提交页并提示；返回 true 表示可以继续 */
function ensureCommitReady(): boolean {
  if (checkedCount.value === 0) {
    localReviewStore.setActiveTab('commit')
    message.info('请先在「提交」页勾选要提交的变更文件')
    return false
  }
  if (!currentCommitMessage.value.trim()) {
    localReviewStore.setActiveTab('commit')
    expandCommitBar()
    message.warning('请填写提交说明，或使用 AI 生成')
    return false
  }
  return true
}

/** 游离 HEAD 阻断提示：不处于任何分支时提交会悬空、推送无目标 */
function warnDetachedHead() {
  message.warning('当前处于游离 HEAD 状态（未位于任何分支），请先切换分支再推送')
}

/** 「提交&推送」主按钮：前置引导后按推送策略分流（同名硬指定 / 弹框询问确认远程与远端分支） */
function startCommitPush() {
  if (!ensureCommitReady()) return
  if (!sameNameTarget.value) {
    warnDetachedHead()
    return
  }
  if (currentRemotes.value.length === 0) {
    message.warning('当前仓库未配置远程仓库，无法推送；可用下拉「仅提交」只提交到本地')
    return
  }
  if (pushMode.value === 'ask') {
    pushDialogScene.value = 'commit-push'
    pushDialogRemoteName.value = dialogDefaultRemote()
    pushDialogRemote.value = currentPushTargets.value.last?.branch || sameNameTarget.value
    pushDialogVisible.value = true
    return
  }
  submitLocalCommit({ remote: currentPushRemote.value, branch: sameNameTarget.value })
}

/** 弹框打开时推送远程的默认值：上次推送的远程（仍在列表中）优先，否则取当前生效远程 */
function dialogDefaultRemote(): string {
  const remotes = currentRemotes.value
  if (remotes.length === 0) return ''
  const lastRemote = currentPushTargets.value.last?.remote
  if (lastRemote && remotes.some((r) => r.name === lastRemote)) return lastRemote
  return currentPushRemote.value
}

/** 下拉「仅提交」：只提交到本地仓库，不推送 */
function onCommitOnlyClick() {
  if (!ensureCommitReady()) return
  submitLocalCommit(null)
}

/** 底部提交条的双态：收起为一条，点击说明占位展开输入框，失焦自动缩回 */
const commitMessageInput = ref<{ focus: () => void } | null>(null)

/** 展开提交说明输入框并自动聚焦 */
function expandCommitBar() {
  localReviewStore.setCommitBarExpanded(true)
  nextTick(() => commitMessageInput.value?.focus())
}

/** 输入框失焦时缩回一条 */
function collapseCommitBar() {
  localReviewStore.setCommitBarExpanded(false)
}

/** Tab 组件回写激活 Tab（写入路径收口 store action） */
function onTabChange(key: string | number) {
  localReviewStore.setActiveTab(String(key))
}

/** 生成提交说明用的文件集合：优先勾选的文件，未勾选时退化为全部变更 */
function filesForMessage(): LocalDiffFile[] {
  const checked = currentChecked.value
  const scoped = localFileList.value.filter((f) => checked.has(f.path))
  return scoped.length > 0 ? scoped : localFileList.value
}

/** 提交/推送两段反馈共用的消息 key：同一位置从「提交中」过渡到「推送中/完成」 */
const PUSH_MESSAGE_KEY = 'mergehub-local-push'

/** 展示详细错误弹窗（长内容滚动，提交失败与推送失败共用） */
function showDetailError(title: string, detail: string) {
  Modal.error({
    title,
    width: 560,
    okText: '知道了',
    content: h(
      'div',
      {
        style:
          'max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.6;',
      },
      detail,
    ),
  })
}

/** 提交勾选的变更文件：pushTarget 非空时提交成功后接着推送到指定远程的指定分支；viaDialog 表示已经过询问对话框确认，跳过二次确认 */
function submitLocalCommit(pushTarget: PushTarget | null, viaDialog = false) {
  const path = selectedLocal.value
  if (!path) return
  const files = localFileList.value.filter((f) => currentChecked.value.has(f.path)).map((f) => f.path)
  const text = currentCommitMessage.value.trim()
  if (files.length === 0) {
    message.warning('请至少勾选一个变更文件')
    return
  }
  if (!text) {
    message.warning('请填写提交说明')
    return
  }
  if (!viaDialog) {
    Modal.confirm({
      title: pushTarget ? '提交并推送变更文件' : '提交变更文件',
      content: pushTarget
        ? `将把 ${files.length} 个文件提交到本地仓库，并推送到 ${pushTarget.remote}/${pushTarget.branch}，是否继续？`
        : `将把 ${files.length} 个文件提交到本地仓库，是否继续？`,
      okText: pushTarget ? '提交并推送' : '提交',
      cancelText: '取消',
      onOk: () => executeCommit(path, files, text, pushTarget),
    })
    return
  }
  void executeCommit(path, files, text, pushTarget)
}

/** 执行提交与（可选）推送：提交失败时勾选与说明草稿保留；推送失败时提交保留不回滚（基本功能定位，异常交由用户在终端处理） */
async function executeCommit(path: string, files: string[], text: string, pushTarget: PushTarget | null) {
  localCommitting.value = true
  try {
    const outcome = await commitChanges(path, files, text)
    // 勾选文件中存在相对 HEAD 已无变化者时提交照常进行，但必须显式告知被跳过清单，禁止静默漏提交
    if (outcome.skipped.length > 0) {
      message.warning(`已跳过 ${outcome.skipped.length} 个无待提交变化的文件：${outcome.skipped.join('、')}`)
    }
    if (!pushTarget) {
      message.success(`提交成功：${outcome.sha}`)
      localReviewStore.clearCommitMessage(path)
      await loadLocalRepo(path, true)
      void localRepos.refreshChanges()
      return
    }
    message.loading({ content: `提交成功：${outcome.sha}，正在推送到 ${pushTarget.remote}/${pushTarget.branch}…`, key: PUSH_MESSAGE_KEY, duration: 0 })
    try {
      await pushCommits(path, pushTarget.remote, sameNameTarget.value, pushTarget.branch)
      message.success({ content: `已提交 ${outcome.sha} 并推送至 ${pushTarget.remote}/${pushTarget.branch}`, key: PUSH_MESSAGE_KEY })
      settingsStore.recordPushTarget(path, pushTarget)
      localReviewStore.clearCommitMessage(path)
      await loadLocalRepo(path, true)
      void localRepos.refreshChanges()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      message.destroy(PUSH_MESSAGE_KEY)
      // 提交已成功：不回滚，草稿使命完成一并清理，刷新让按钮与角标回到真实状态
      localReviewStore.clearCommitMessage(path)
      await loadLocalRepo(path, true)
      void localRepos.refreshChanges()
      showDetailError(`提交成功（${outcome.sha}），但推送失败`, detail)
    }
  } catch (err) {
    showDetailError('提交失败', err instanceof Error ? err.message : String(err))
  } finally {
    localCommitting.value = false
  }
}

/** 独立「推送」按钮：把当前分支领先远端的提交推送出去 */
function startPushOnly() {
  if (!sameNameTarget.value) {
    warnDetachedHead()
    return
  }
  if (currentRemotes.value.length === 0) {
    message.warning('当前仓库未配置远程仓库，无法推送')
    return
  }
  if (pushMode.value === 'ask') {
    pushDialogScene.value = 'push-only'
    pushDialogRemoteName.value = dialogDefaultRemote()
    pushDialogRemote.value = currentPushTargets.value.last?.branch || sameNameTarget.value
    pushDialogVisible.value = true
    return
  }
  void pushOnly({ remote: currentPushRemote.value, branch: sameNameTarget.value })
}

/** 仅推送当前分支到指定远程的指定分支（不带提交） */
async function pushOnly(target: PushTarget) {
  const path = selectedLocal.value
  const local = sameNameTarget.value
  if (!path || !local) return
  localPushing.value = true
  message.loading({ content: `正在推送到 ${target.remote}/${target.branch}…`, key: PUSH_MESSAGE_KEY, duration: 0 })
  try {
    await pushCommits(path, target.remote, local, target.branch)
    message.success({ content: `已推送至 ${target.remote}/${target.branch}`, key: PUSH_MESSAGE_KEY })
    settingsStore.recordPushTarget(path, target)
    await loadLocalRepo(path, true)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    message.destroy(PUSH_MESSAGE_KEY)
    showDetailError('推送失败', detail)
  } finally {
    localPushing.value = false
  }
}

/** 询问对话框选择历史分支：从候选反查该分支记录的远程并联动远程下拉（记录无远程或不在远程列表时不动当前选择） */
function onPushDialogSelect(value: string) {
  const hit = pushDialogOptions.value.find((o) => o.value === value)
  if (!hit?.remote) return
  if (currentRemotes.value.some((r) => r.name === hit.remote)) {
    pushDialogRemoteName.value = hit.remote
  }
}

/** 工作台推送目标标签的远程切换菜单：写入手动选择并即时反馈 */
function onPushRemoteMenuClick({ key }: { key: string | number }) {
  const name = String(key)
  if (!selectedLocal.value) return
  selectedRemotes[selectedLocal.value] = name
  message.info(`推送远程已切换为 ${name}`)
}

/** 询问对话框确定：校验远程与分支输入后按场景分发；校验不过时保持对话框打开 */
function onPushDialogOk() {
  const remoteName = pushDialogRemoteName.value.trim()
  if (!remoteName) {
    message.warning('请选择要推送到的远程仓库')
    return
  }
  const remote = pushDialogRemote.value.trim()
  if (!remote) {
    message.warning('请填写要推送到的远端分支名')
    return
  }
  if (remote.startsWith('-') || /\s/.test(remote)) {
    message.warning('远端分支名不能以 - 开头或包含空白字符')
    return
  }
  pushDialogVisible.value = false
  selectedRemotes[selectedLocal.value] = remoteName
  if (pushDialogScene.value === 'push-only') {
    void pushOnly({ remote: remoteName, branch: remote })
    return
  }
  submitLocalCommit({ remote: remoteName, branch: remote }, true)
}

/** 用 AI 根据勾选（或全部）变更文件生成简短提交说明；完成后切回提交页并展开输入框，避免用户切走时静默完成无感知 */
async function generateCommitText() {
  if (!selectedLocal.value) return
  if (!aiStore.configReady) {
    message.warning('请先在设置中配置 AI 模型')
    return
  }
  const repoKey = selectedLocal.value
  localReviewStore.setMessageGenerating(true)
  try {
    const text = await generateCommitMessage(
      aiStore.modelConfig(),
      selectedLocalName.value || selectedLocal.value,
      filesForMessage(),
    )
    localReviewStore.setCommitMessage(repoKey, text)
    if (activeTab.value !== 'commit') localReviewStore.setActiveTab('commit')
    localReviewStore.setCommitBarExpanded(true)
    message.success('已生成提交说明')
  } catch (err) {
    message.error(friendlyAiError(err))
  } finally {
    localReviewStore.setMessageGenerating(false)
  }
}

/** 当前仓库的分支下拉选项 */
const branchOptions = computed(() =>
  (localBranches[selectedLocal.value] ?? []).map((b) => ({ label: b.name, value: b.name })),
)

/** 切换本地分支：比对基准与提交目标随之对准新分支，成功后强刷概要与工作区变更 */
async function onSwitchBranch(branch: string | number) {
  const path = selectedLocal.value
  const name = String(branch).trim()
  if (!path || !name || name === localInfo.value?.branch || branchSwitching.value) return
  branchSwitching.value = true
  try {
    await checkoutBranch(path, name)
    message.success(`已切换到分支 ${name}`)
    await loadLocalRepo(path, true)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    // 切换失败（如工作区变更与目标分支冲突）时同步一次状态，让下拉框显示弹回当前分支
    await loadLocalRepo(path, true)
  } finally {
    branchSwitching.value = false
  }
}

/** 处理来自工作台的跳转参数：?local=直达本地仓库工作台 */
async function applyRepoQuery(): Promise<void> {
  const local = route.query.local
  if (typeof local === 'string' && local) {
    if (localRepos.repos.some((r) => r.path === local)) {
      activeGroup.value = 'local'
      await selectLocalRepo(local)
    }
  }
}

onActivated(() => {
  void applyRepoQuery()
  startDiffPolling()
  // 组件若因路由级缓存失效而重建，选中仓库仍在但工作台数据为空，补一次加载保证切回后工作台完整可用
  if (selectedLocal.value && !localDiffs[selectedLocal.value]) void loadLocalRepo(selectedLocal.value)
  // 保活恢复时立即拉一次工作区变更，避免先展示离开时的旧数据、等 60 秒轮询才刷新
  void pollSelectedDiff()
})

/** 弹窗确认后真正发起本地评审：立即切到 AI 评审 Tab 展示进度（与远程评审行为一致） */
function beginLocalReview(mode: AiReviewMode) {
  const path = selectedLocal.value
  if (!path) return
  localReviewStore.setActiveTab('ai')
  void aiStore.runLocalReview(
    {
      path,
      branch: localInfo.value?.branch ?? '',
      files: localFileList.value,
    },
    mode,
  )
}

const flow = useAiReviewFlow({
  aiKey: computed(() => (selectedLocal.value ? localResultKey(selectedLocal.value) : '')),
  activeRepoId: computed(() => selectedLocal.value || null),
  changedFiles: computed(() => localFileList.value),
  reviewTarget: computed(() =>
    selectedLocal.value
      ? buildLocalReviewDetail(
          selectedLocal.value,
          localInfo.value?.branch ?? '',
          localFileList.value,
        )
      : null,
  ),
  showFilesTab: () => {
    localReviewStore.setActiveTab('files')
  },
  beginReview: (mode) => beginLocalReview(mode),
  exportTitle: computed(() =>
    selectedLocal.value
      ? `${selectedLocalName.value || selectedLocal.value}（工作区变更）`
      : '',
  ),
  exportFilename: computed(() => {
    if (!selectedLocal.value) return 'ai-review.md'
    // 文件名优先用仓库显示名（取自路径末段目录名，不含 Windows 非法文件名字符），回退完整路径时兜底清理非法字符
    const base = (selectedLocalName.value || selectedLocal.value).replace(/[\\/:*?"<>|]/g, '-')
    return `ai-review-local-${base}-${dayjs().format('YYYYMMDD-HHmmss')}.md`
  }),
})

const {
  aiReviewing,
  aiResult,
  openModeModal,
  ensureConfigReady,
  detailBodyRef,
  showBackTop,
  onDetailScroll,
  scrollDetailToTop,
  registerFileCard,
} = flow

const DIFF_POLL_INTERVAL = 60_000

let diffPollTimer: number | null = null

function startDiffPolling() {
  if (diffPollTimer !== null) return
  diffPollTimer = window.setInterval(() => void pollSelectedDiff(), DIFF_POLL_INTERVAL)
}

function stopDiffPolling() {
  if (diffPollTimer === null) return
  window.clearInterval(diffPollTimer)
  diffPollTimer = null
}

/** 逐文件逐字段比较两份工作区 diff（LocalDiffFile 均为基本类型字段）：避免整表 JSON.stringify 的序列化开销，与对象键序无关，patch 内容变化仍能精确检出 */
function diffsEqual(prev: LocalDiffFile[], next: LocalDiffFile[]): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  return prev.every((file, i) => {
    const other = next[i]
    return (
      file.path === other.path &&
      file.status === other.status &&
      file.additions === other.additions &&
      file.deletions === other.deletions &&
      file.patch === other.patch
    )
  })
}

async function pollSelectedDiff() {
  const path = selectedLocal.value
  if (
    !path ||
    localLoading[path] ||
    localCommitting.value ||
    messageGenerating.value ||
    branchSwitching.value ||
    aiReviewing.value
  ) {
    return
  }
  try {
    const diffs = await getLocalDiff(path)
    // await 期间仓库可能已被移除：不为已删除仓库写回缓存
    if (!isRepoTracked(path)) return
    const prev = localDiffs[path]
    if (prev !== undefined && diffsEqual(prev, diffs)) {
      return
    }
    localDiffs[path] = diffs
    checkedFiles[path] = mergeChecked(path, prev, diffs)
  } catch (err) {
    console.debug('[local-review] 自动刷新工作区变更失败', err)
  }
}

onDeactivated(stopDiffPolling)

onUnmounted(stopDiffPolling)

/** 仓库卡片角标数：优先展示工作台已加载的实时文件数，未加载时回退到后台轮询的统计数 */
function repoDiffCount(path: string): number {
  return localDiffs[path]?.length ?? localRepos.changeCounts[path] ?? 0
}

/** 头部/报告面板共用的发起评审入口：已有结果时切到 AI 评审 Tab 查看（重新分析走报告面板按钮），否则经模式弹窗发起 */
function startReview(force = false) {
  if (!selectedLocal.value) return
  if (!force && aiResult.value) {
    localReviewStore.setActiveTab('ai')
    return
  }
  if (!ensureConfigReady()) return
  if (localFileList.value.length === 0) {
    message.info('工作区没有待评审的变更文件')
    return
  }
  openModeModal()
}
</script>

<template>
  <div class="review-page">
    <aside class="review-aside">
      <div class="aside-toolbar">
        <span class="aside-title">本地仓库</span>
        <button
          type="button"
          class="add-btn"
          aria-label="添加本地仓库"
          @click="addLocalRepo"
        >
          <PlusOutlined />
        </button>
      </div>
      <div class="aside-segments">
        <a-segmented
          v-model:value="activeGroup"
          block
          :options="reviewGroupOptions"
        />
      </div>
      <div class="aside-body">
        <div v-if="localRepos.repos.length === 0" class="aside-empty">
          <a-empty
            :image="simpleImage"
            description="暂无本地仓库"
            :image-style="{ height: '40px' }"
          >
            <a-button type="primary" size="small" @click="addLocalRepo">
              选择文件夹
            </a-button>
          </a-empty>
        </div>
        <div v-else class="repo-list">
          <div
            v-for="repo in localRepos.repos"
            :key="repo.path"
            class="repo-card"
            :class="{ selected: selectedLocal === repo.path }"
          >
            <div
              class="repo-head"
              role="button"
              tabindex="0"
              @click="selectLocalRepo(repo.path)"
              @keydown.enter.prevent="selectLocalRepo(repo.path)"
              @keydown.space.prevent="selectLocalRepo(repo.path)"
            >
              <span class="repo-name" :title="repo.path">{{ repo.name }}</span>
              <span
                v-if="repoDiffCount(repo.path) > 0"
                class="repo-count"
              >
                {{ repoDiffCount(repo.path) }}
              </span>
              <span class="repo-actions">
                <a-tooltip title="打开所在文件夹">
                  <a-button
                    type="text"
                    size="small"
                    class="repo-action"
                    @click.stop="openLocalFolder(repo.path)"
                  >
                    <template #icon><FolderOpenOutlined /></template>
                  </a-button>
                </a-tooltip>
                <a-tooltip title="刷新工作区变更">
                  <a-button
                    type="text"
                    size="small"
                    class="repo-action"
                    @click.stop="loadLocalRepo(repo.path, true)"
                  >
                    <template #icon><ReloadOutlined /></template>
                  </a-button>
                </a-tooltip>
                <a-popconfirm
                  title="移除该本地仓库？"
                  @confirm="removeLocalRepo(repo.path)"
                >
                  <a-tooltip title="移除仓库">
                    <a-button
                      type="text"
                      size="small"
                      danger
                      class="repo-action"
                      @click.stop
                    >
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </a-tooltip>
                </a-popconfirm>
              </span>
            </div>
            <div v-if="localErrors[repo.path]" class="local-error">
              {{ localErrors[repo.path] }}
            </div>
            <div v-else-if="localRepos.changeErrors[repo.path]" class="local-error">
              {{ localRepos.changeErrors[repo.path] }}
            </div>
          </div>
        </div>
      </div>
      <div class="aside-footer">
        本地仓库 {{ localRepos.repos.length }} 个 · 点击仓库名查看待提交的变更文件
      </div>
    </aside>

    <main class="review-main">
      <div class="review-local">
        <div v-if="!selectedLocal" class="review-empty">
          <a-empty description="从左侧选择本地仓库，审阅待提交的变更">
            <span class="empty-hint">
              支持勾选文件提交，可先让 AI 评审变更内容
            </span>
          </a-empty>
        </div>
        <template v-else>
          <header class="detail-header">
            <div class="detail-title-row">
              <h3 class="detail-title">{{ selectedLocalName || selectedLocal }}</h3>
            </div>
            <div class="detail-meta">
              <a-tag color="default">本地仓库</a-tag>
              <a-tag color="processing">工作区</a-tag>
              <span v-if="localInfo?.branch" class="meta-branch-switch">
                <BranchesOutlined />
                <a-tooltip title="切换分支：工作区比对与提交将随之对准新分支">
                  <a-select
                    class="branch-select"
                    :value="localInfo.branch"
                    size="small"
                    :options="branchOptions"
                    :loading="branchSwitching"
                    @change="onSwitchBranch"
                  />
                </a-tooltip>
              </span>
              <span class="detail-stats">
                <span class="stat-add">+{{ localAdditions }}</span>
                <span class="stat-del">-{{ localDeletions }}</span>
                <span class="stat-files">{{ localFileList.length }} 个文件</span>
              </span>
            </div>
            <div class="detail-actions">
              <div class="detail-actions-left">
                <a-button
                  size="small"
                  :loading="localLoading[selectedLocal] === true"
                  @click="loadLocalRepo(selectedLocal, true)"
                >
                  <template #icon><ReloadOutlined /></template>
                  刷新
                </a-button>
              </div>
              <div class="detail-actions-right">
                <a-dropdown
                  v-if="pushMode === 'same-name' && sameNameTarget && currentRemotes.length > 0"
                  :trigger="currentRemotes.length > 1 ? ['click'] : []"
                >
                  <a-tag
                    class="push-target-tag"
                    :class="{ clickable: currentRemotes.length > 1 }"
                    :title="pushTagTitle"
                  >
                    → {{ currentPushRemote }}/{{ sameNameTarget }}
                  </a-tag>
                  <template v-if="currentRemotes.length > 1" #overlay>
                    <a-menu @click="onPushRemoteMenuClick">
                      <a-menu-item v-for="r in currentRemotes" :key="r.name">
                        <div class="push-remote-option">
                          <span class="push-remote-name">
                            <CheckOutlined v-if="r.name === currentPushRemote" />
                            {{ r.name }}
                          </span>
                          <span class="push-remote-url">{{ r.pushUrl }}</span>
                        </div>
                      </a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
                <a-tag
                  v-else-if="pushMode === 'same-name' && sameNameTarget"
                  class="push-target-tag"
                  title="当前仓库未配置远程仓库，推送不可用"
                >
                  → 未配置远程/{{ sameNameTarget }}
                </a-tag>
                <a-tooltip :title="pushOnlyTip">
                  <a-button
                    v-if="localInfo && localInfo.ahead > 0"
                    size="small"
                    :loading="localPushing"
                    @click="startPushOnly"
                  >
                    <template #icon><UploadOutlined /></template>
                    推送 ({{ localInfo.ahead }})
                  </a-button>
                </a-tooltip>
                <a-tooltip :title="commitButtonTip">
                  <CommitButton
                    :disabled="commitDisabled"
                    :loading="localCommitting"
                    @click="startCommitPush"
                    @commit-only="onCommitOnlyClick"
                  />
                </a-tooltip>
                <a-tooltip title="使用大模型分析 diff 并生成结构化评审意见">
                  <a-button
                    size="small"
                    type="primary"
                    ghost
                    :loading="aiReviewing"
                    @click="startReview()"
                  >
                    <template #icon><RobotOutlined /></template>
                    AI 评审
                  </a-button>
                </a-tooltip>
              </div>
            </div>
          </header>
          <div ref="detailBodyRef" class="detail-body" @scroll="onDetailScroll">
            <a-alert
              v-if="localErrors[selectedLocal]"
              type="error"
              show-icon
              :message="localErrors[selectedLocal]"
            />
            <div
              v-else-if="localLoading[selectedLocal] && localFileList.length === 0"
              class="local-loading"
            >
              <a-spin size="small" /> 正在读取工作区变更…
            </div>
            <div v-else-if="localFileList.length === 0" class="review-empty local-clean">
              <a-empty description="工作区干净，没有待提交的变更" />
            </div>
            <a-tabs v-else :active-key="activeTab" @update:active-key="onTabChange">
              <a-tab-pane key="files" :tab="`变更文件 (${localFileList.length})`">
                <div class="diff-list">
                  <DiffFileCard
                    v-for="f in localFileList"
                    :key="f.path"
                    :ref="(el) => registerFileCard(f.path, el)"
                    :file="f"
                    platform-label="本地变更"
                  />
                </div>
              </a-tab-pane>
              <a-tab-pane key="ai" tab="AI 评审">
                <AiReportPanel
                  :flow="flow"
                  :start-review="startReview"
                  empty-text="尚未对该仓库的变更进行 AI 评审"
                />
              </a-tab-pane>
              <a-tab-pane key="commit" tab="提交">
                <div class="ai-review-layout">
                  <section class="ai-result-card commit-card">
                    <div class="commit-files-head">
                      <a-checkbox
                        :checked="allChecked"
                        :indeterminate="someChecked"
                        :disabled="localFileList.length === 0"
                        @change="onToggleAllFiles"
                      >
                        全选
                      </a-checkbox>
                      <span class="commit-files-count">
                        已选 {{ checkedCount }} / {{ localFileList.length }} 个文件
                      </span>
                    </div>
                    <div class="commit-file-list">
                      <label
                        v-for="f in localFileList"
                        :key="f.path"
                        class="commit-file-row"
                        :class="{ checked: currentChecked.has(f.path) }"
                      >
                        <a-checkbox
                          :checked="currentChecked.has(f.path)"
                          @change="onCommitFileCheck(f.path, $event)"
                        />
                        <a-tag :color="LOCAL_STATUS_META[f.status].color" class="commit-file-tag">
                          {{ LOCAL_STATUS_META[f.status].label }}
                        </a-tag>
                        <span class="commit-file-path" :title="f.path">{{ f.path }}</span>
                        <span class="commit-file-stats">
                          <span class="stat-add">+{{ f.additions }}</span>
                          <span class="stat-del">-{{ f.deletions }}</span>
                        </span>
                      </label>
                    </div>
                    <div class="commit-sticky-bar">
                      <a-textarea
                        v-if="commitBarExpanded"
                        ref="commitMessageInput"
                        v-model:value="currentCommitMessage"
                        :rows="3"
                        :maxlength="500"
                        placeholder="填写提交说明（可用 AI 生成）"
                        @blur="collapseCommitBar"
                      />
                      <div v-else class="commit-bar-collapsed">
                        <button
                          type="button"
                          class="commit-bar-placeholder"
                          :class="{ 'has-text': currentCommitMessage.trim() }"
                          @click="expandCommitBar"
                        >
                          {{ currentCommitMessage.trim() || '填写提交说明（可用 AI 生成）' }}
                        </button>
                        <span class="commit-sticky-summary">
                          已选 {{ checkedCount }} / {{ localFileList.length }} 个文件
                        </span>
                        <CommitButton
                          :disabled="commitDisabled"
                          :loading="localCommitting"
                          @click="startCommitPush"
                          @commit-only="onCommitOnlyClick"
                        />
                      </div>
                      <div v-if="commitBarExpanded" class="commit-bar-actions">
                        <span class="commit-sticky-summary">
                          已选 {{ checkedCount }} / {{ localFileList.length }} 个文件
                        </span>
                        <div class="commit-bar-buttons">
                          <a-button
                            size="small"
                            :loading="messageGenerating"
                            @mousedown.prevent
                            @click="generateCommitText"
                          >
                            <template #icon><RobotOutlined /></template>
                            AI 生成说明
                          </a-button>
                          <CommitButton
                            :disabled="commitDisabled"
                            :loading="localCommitting"
                            @mousedown.prevent
                            @click="startCommitPush"
                            @commit-only="onCommitOnlyClick"
                          />
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              </a-tab-pane>
            </a-tabs>
          </div>
          <transition name="fade">
            <button
              v-if="showBackTop"
              class="back-top"
              type="button"
              title="回到顶部"
              @click="scrollDetailToTop"
            >
              <VerticalAlignTopOutlined />
            </button>
          </transition>
        </template>
      </div>
    </main>
    <a-modal
      v-model:open="pushDialogVisible"
      :title="pushDialogScene === 'push-only' ? '推送分支' : '提交并推送'"
      ok-text="推送"
      cancel-text="取消"
      :mask-closable="false"
      @ok="onPushDialogOk"
    >
      <div class="push-dialog-form">
        <div class="push-dialog-row">
          <span class="push-dialog-label">本地分支</span>
          <span class="push-dialog-branch">{{ sameNameTarget || localInfo?.branch || '（未知）' }}</span>
        </div>
        <div class="push-dialog-row">
          <span class="push-dialog-label">推送远程</span>
          <div class="push-dialog-remote-cell">
            <a-select
              v-model:value="pushDialogRemoteName"
              class="push-dialog-input"
              :options="pushRemoteOptions"
              placeholder="选择推送远程仓库"
            />
            <p v-if="pushDialogRemoteUrl" class="push-dialog-remote-url">{{ pushDialogRemoteUrl }}</p>
          </div>
        </div>
        <div class="push-dialog-row">
          <span class="push-dialog-label">远端分支</span>
          <a-auto-complete
            v-model:value="pushDialogRemote"
            class="push-dialog-input"
            :options="pushDialogOptions"
            placeholder="输入远端分支名，可从历史记录选择"
            @select="onPushDialogSelect"
          >
            <template #option="{ value, remote }">
              <div class="push-target-option">
                <span class="push-target-option-name">{{ value }}</span>
                <span class="push-target-option-remote">{{ remote || '（未记录远程）' }}</span>
                <a-button
                  v-if="remote"
                  type="text"
                  size="small"
                  class="push-target-option-remove"
                  title="从历史记录中删除"
                  @click.stop="settingsStore.removePushTarget(selectedLocal, { remote: String(remote ?? ''), branch: String(value) })"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </div>
            </template>
          </a-auto-complete>
        </div>
        <p v-if="pushDialogCreateHint" class="push-dialog-hint">{{ pushDialogCreateHint }}</p>
        <p v-if="pushDialogScene === 'commit-push'" class="push-dialog-note">
          将把当前勾选的 {{ checkedCount }} 个变更文件提交到本地仓库后推送；本地分支保持当前分支不变，此处只确认推送目标。
        </p>
      </div>
    </a-modal>
    <ReviewModeModal :flow="flow" />
  </div>
</template>

<style scoped>
.local-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 0;
  font-size: 13px;
  color: #8c8c8c;
}

.local-error {
  padding: 10px 14px;
  font-size: 12px;
  color: rgba(255, 77, 79, 0.9);
}

.review-local {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.local-clean {
  flex: 1;
}

.commit-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.commit-files-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.commit-files-count {
  font-size: 12px;
  color: #8c8c8c;
}

.commit-file-list {
  border: 1px solid #ececec;
  border-radius: 8px;
  background: #fff;
}

.commit-sticky-bar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 -16px -12px;
  padding: 10px 16px;
  border-top: 1px solid #f0f0f0;
  background: #fff;
  border-radius: 0 0 8px 8px;
}

.commit-bar-collapsed {
  display: flex;
  align-items: center;
  gap: 12px;
}

.commit-bar-placeholder {
  flex: 1;
  min-width: 0;
  padding: 4px 0;
  border: none;
  background: none;
  font-size: 13px;
  text-align: left;
  color: #bfbfbf;
  cursor: text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-bar-placeholder.has-text {
  color: rgba(0, 0, 0, 0.85);
}

.commit-bar-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.commit-bar-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.commit-sticky-summary {
  flex-shrink: 0;
  font-size: 12px;
  color: #8c8c8c;
}

.commit-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid #f5f5f5;
  cursor: pointer;
  transition: background 0.2s;
}

.commit-file-row:last-child {
  border-bottom: none;
}

.commit-file-row:hover {
  background: #fafafa;
}

.commit-file-row.checked {
  background: #f0f7ff;
}

.commit-file-tag {
  flex-shrink: 0;
}

.commit-file-path {
  flex: 1;
  min-width: 0;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-file-stats {
  flex-shrink: 0;
  display: flex;
  gap: 6px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.push-target-tag {
  flex-shrink: 0;
  margin-inline-end: 0;
  cursor: default;
}

.push-target-tag.clickable {
  cursor: pointer;
}

.push-remote-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 240px;
  padding: 2px 0;
}

.push-remote-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.push-remote-url {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  word-break: break-all;
}

.push-dialog-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.push-dialog-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.push-dialog-label {
  flex-shrink: 0;
  width: 60px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 13px;
}

.push-dialog-branch {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.85);
  word-break: break-all;
}

.push-dialog-input {
  flex: 1;
}

.push-dialog-hint {
  margin: 0;
  color: #d46b08;
  font-size: 12px;
  line-height: 1.6;
}

.push-dialog-note {
  margin: 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.6;
}

.push-target-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.push-target-option-name {
  overflow: hidden;
  min-width: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.push-target-option-remove {
  flex-shrink: 0;
}

.push-target-option-remote {
  overflow: hidden;
  flex: 1;
  min-width: 0;
  margin: 0 4px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  white-space: nowrap;
  text-align: right;
  text-overflow: ellipsis;
}

.push-dialog-remote-cell {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}

.push-dialog-remote-url {
  margin: 4px 0 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}
</style>
