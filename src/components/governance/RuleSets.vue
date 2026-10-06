<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Empty, message } from 'ant-design-vue'
import dayjs from 'dayjs'
import { useReviewRulesStore } from '../../stores/reviewRules'
import {
  AI_ISSUE_TYPE_META,
  type AiIssueType,
  type ReviewRule,
  type RuleKind,
  type RuleSet,
  type RuleSourceKind,
} from '../../types/ai'

const rulesStore = useReviewRulesStore()
const route = useRoute()
const router = useRouter()

// 规则集持久化失败提示：store 任一 action 写盘失败都更新 persistState，此处统一 toast
// （比逐调用点判返回值可靠：模板内联调用如 toggleRule 也覆盖，未来新增 action 自动纳入）；
// 监听 failSeq（每次失败自增）而非布尔标志——watch 只在值变化时触发，连续失败时布尔保持
// false 不变会吞掉第二次起的提示；内存态不受影响，用户后续任意规则操作会自动重试整份落盘
watch(
  () => rulesStore.persistState.failSeq,
  (seq) => {
    if (seq > 0 && !rulesStore.persistState.ok) {
      message.error('规范集保存失败（存储空间不足或访问受限），本次修改刷新后将丢失，请及时导出备份')
    }
  },
)

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

/** 规则来源徽标：手工为缺省来源，行内不显示以减少噪音；键宽松为 string，枚举外的持久化 kind 由 sourceMeta 兜底显示原值 */
const SOURCE_META: Record<string, { label: string; color: string }> = {
  manual: { label: '手工', color: 'default' },
  'exempt-sediment': { label: '豁免沉淀', color: 'geekblue' },
  'comply-sediment': { label: '遵守沉淀', color: 'cyan' },
  'ai-summary': { label: 'AI 归纳', color: 'purple' },
}

/** 快照记录类型标签：旧快照 type 可能不在枚举内，兜底显示原值 */
function snapshotTypeMeta(type: string): { label: string; color: string } {
  return AI_ISSUE_TYPE_META[type as AiIssueType] ?? { label: type, color: 'default' }
}

/** 规则来源标签：持久化数据的 kind 可能不在枚举内，兜底显示原值（参数放宽为 string 使兜底分支运行时可达） */
function sourceMeta(kind: string): { label: string; color: string } {
  return SOURCE_META[kind] ?? { label: kind, color: 'default' }
}

const RULE_EXAMPLES: { name: string; content: string }[] = [
  {
    name: 'Vue 3 组件规范',
    content: [
      '- 组件统一使用 <script setup lang="ts"> 写法',
      '- 组件名必须多单词（如 UserCard，禁止 User）',
      '- props 使用 defineProps 泛型声明并标注类型',
      '- 模板中禁止复杂表达式，逻辑抽为 computed',
      '- 严禁 v-html 渲染不可信内容',
    ].join('\n'),
  },
  {
    name: 'TypeScript 严格性规范',
    content: [
      '- 禁止使用 any，不确定类型时用 unknown 并收窄',
      '- 导出函数必须显式标注返回类型',
      '- 禁止 @ts-ignore / @ts-nocheck',
      '- 异步操作必须有错误处理，禁止静默吞错',
      '- 优先使用 const 与 readonly',
    ].join('\n'),
  },
  {
    name: '提交与命名规范',
    content: [
      '- 提交信息遵循 Conventional Commits（feat/fix/refactor 等）',
      '- 变量与函数用 camelCase，类型与类用 PascalCase，常量用 UPPER_SNAKE_CASE',
      '- 单个提交只做一件事，禁止混杂格式化与逻辑变更',
    ].join('\n'),
  },
]

const setModalOpen = ref(false)
const setEditingId = ref<string | null>(null)
const setForm = reactive({ name: '' })

function openAddSet() {
  setEditingId.value = null
  setForm.name = ''
  setModalOpen.value = true
}

function openRenameSet(set: RuleSet) {
  setEditingId.value = set.id
  setForm.name = set.name
  setModalOpen.value = true
}

function submitSet() {
  const name = setForm.name.trim()
  if (!name) {
    message.warning('请输入规范集名称')
    return
  }
  if (setEditingId.value) {
    rulesStore.renameSet(setEditingId.value, name)
    message.success('规范集已重命名')
  } else {
    const created = rulesStore.addSet(name)
    rulesStore.setActive(created.id)
    message.success(`规范集「${created.name}」已创建并设为使用`)
  }
  setModalOpen.value = false
}

function removeSet(set: RuleSet) {
  rulesStore.removeSet(set.id)
  message.success('已删除该规范集')
}

function selectSet(set: RuleSet) {
  if (set.id === rulesStore.activeSetId) return
  rulesStore.setActive(set.id)
  message.success(`已切换为使用「${set.name}」`)
}

const activeSetId = computed(() => rulesStore.activeSet?.id ?? '')

const ruleModalOpen = ref(false)
const ruleForm = reactive<{
  id: string | null
  name: string
  content: string
  kind: RuleKind
  /** 编辑中的规则来源（溯源快照提示用），新增时为 null */
  sourceKind: RuleSourceKind | null
}>({ id: null, name: '', content: '', kind: 'standard', sourceKind: null })

function openAddRule(example?: { name: string; content: string }) {
  ruleForm.id = null
  ruleForm.name = example?.name ?? ''
  ruleForm.content = example?.content ?? ''
  ruleForm.kind = 'standard'
  ruleForm.sourceKind = null
  ruleModalOpen.value = true
}

function openEditRule(rule: ReviewRule) {
  ruleForm.id = rule.id
  ruleForm.name = rule.name
  ruleForm.content = rule.content
  ruleForm.kind = rule.kind
  ruleForm.sourceKind = rule.source?.kind ?? null
  ruleModalOpen.value = true
}

function submitRule() {
  const name = ruleForm.name.trim()
  const content = ruleForm.content.trim()
  if (!name || !content) {
    message.warning('规范名称与内容不能为空')
    return
  }
  if (ruleForm.id) {
    rulesStore.updateRule(activeSetId.value, ruleForm.id, { name, content, kind: ruleForm.kind })
    message.success('规范已更新')
  } else {
    rulesStore.addRule(activeSetId.value, name, content, ruleForm.kind)
    message.success('规范已添加，评审时将自动生效')
  }
  ruleModalOpen.value = false
}

function removeRule(rule: ReviewRule) {
  rulesStore.removeRule(activeSetId.value, rule.id)
  message.success('已删除该规范')
}

function onExampleClick({ key }: { key: string | number }) {
  openAddRule(RULE_EXAMPLES[Number(key)])
}

/** 规则类型筛选（含全部），按钮带条数角标 */
type KindFilter = 'all' | RuleKind
const kindFilter = ref<KindFilter>('all')

const kindCounts = computed<Record<KindFilter, number>>(() => {
  const rules = rulesStore.activeSet?.rules ?? []
  return {
    all: rules.length,
    standard: rules.filter((r) => r.kind === 'standard').length,
    exemption: rules.filter((r) => r.kind === 'exemption').length,
  }
})

const filteredRules = computed(() => {
  const rules = rulesStore.activeSet?.rules ?? []
  return kindFilter.value === 'all' ? rules : rules.filter((r) => r.kind === kindFilter.value)
})

/** 展开源源面板的规则 id */
const expandedRuleIds = ref<string[]>([])

function isRuleExpanded(id: string): boolean {
  return expandedRuleIds.value.includes(id)
}

function toggleRuleExpand(id: string): void {
  expandedRuleIds.value = isRuleExpanded(id)
    ? expandedRuleIds.value.filter((x) => x !== id)
    : [...expandedRuleIds.value, id]
}

/** 判断规则是否来源于治理记录沉淀（豁免/遵守），删除与溯源提示按此区分 */
function isSedimentSource(kind: RuleSourceKind | null | undefined): boolean {
  return kind === 'exempt-sediment' || kind === 'comply-sediment'
}

/** 沉淀来源弹窗提示标题：按来源种类区分豁免/遵守表述 */
function sedimentAlertTitle(kind: RuleSourceKind | null | undefined): string {
  return kind === 'exempt-sediment' ? '此规范来源于豁免记录沉淀' : '此规范来源于遵守记录沉淀'
}

/** 反向跳转：按沉淀来源切到对应治理记录视图查看现行状态；模板以 isSedimentSource 守卫，仅豁免/遵守沉淀可触发（ai-summary 规则可能混合两类记录来源无法可靠路由，manual 无对应记录）；push 保留既有参数并允许浏览器回退 */
function goRecords(kind?: RuleSourceKind): void {
  router.push({ query: { ...route.query, view: kind === 'comply-sediment' ? 'comply' : 'exempt' } })
}
</script>

<template>
  <div>
    <div class="rule-sets">
      <div class="sets-side">
        <div class="sets-side-head">
          <span class="sets-side-title">规范集</span>
          <a-button size="small" type="primary" @click="openAddSet">新建</a-button>
        </div>
        <div class="set-list">
          <div
            v-for="set in rulesStore.sets"
            :key="set.id"
            class="set-item"
            :class="{ active: set.id === rulesStore.activeSetId }"
            @click="selectSet(set)"
          >
            <div class="set-item-name">
              <span class="set-item-label">{{ set.name }}</span>
              <a-tag v-if="set.id === rulesStore.activeSetId" color="success">使用中</a-tag>
            </div>
            <div class="set-item-count">{{ set.rules.length }} 条规范</div>
            <div class="set-item-actions" @click.stop>
              <a-button size="small" type="text" @click="openRenameSet(set)">重命名</a-button>
              <a-popconfirm
                v-if="rulesStore.sets.length > 1"
                title="确认删除该规范集？"
                @confirm="removeSet(set)"
              >
                <a-button size="small" type="text" danger>删除</a-button>
              </a-popconfirm>
            </div>
          </div>
        </div>
        <p class="sets-hint">点击规范集即可切换为 AI 评审使用的规范。</p>
      </div>
      <div class="rules-main">
        <div class="rule-toolbar">
          <a-dropdown>
            <a-button size="small">示例模板</a-button>
            <template #overlay>
              <a-menu @click="onExampleClick">
                <a-menu-item v-for="(ex, i) in RULE_EXAMPLES" :key="String(i)">
                  {{ ex.name }}
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
          <a-button size="small" type="primary" @click="openAddRule()">
            添加规范
          </a-button>
          <div class="kind-filter">
            <a-radio-group v-model:value="kindFilter" size="small" button-style="solid">
              <a-radio-button value="all">全部 {{ kindCounts.all }}</a-radio-button>
              <a-radio-button value="standard">遵守规范 {{ kindCounts.standard }}</a-radio-button>
              <a-radio-button value="exemption">豁免规则 {{ kindCounts.exemption }}</a-radio-button>
            </a-radio-group>
          </div>
        </div>
        <p class="rule-hint">
          遵守规范：AI 评审时逐条对照 diff 核验，违反项以「规范」类型标注并引用规则名。豁免规则（如从豁免记录沉淀）：AI 不再报告与之相同或实质相似的问题。
        </p>
        <a-empty
          v-if="(rulesStore.activeSet?.rules.length ?? 0) === 0"
          :image="simpleImage"
          description="当前规范集暂无规范，可从示例模板快速开始"
          :image-style="{ height: '48px' }"
        />
        <a-empty
          v-else-if="filteredRules.length === 0"
          :image="simpleImage"
          description="当前筛选条件下暂无规范"
          :image-style="{ height: '48px' }"
        />
        <div v-else class="rule-list">
          <div v-for="rule in filteredRules" :key="rule.id" class="rule-item">
            <div class="rule-row">
              <a-switch
                :checked="rule.enabled"
                size="small"
                @change="rulesStore.toggleRule(activeSetId, rule.id)"
              />
              <div class="rule-main">
                <div class="rule-name">
                  {{ rule.name }}
                  <a-tag v-if="rule.kind === 'exemption'" color="orange" class="rule-kind-tag">
                    豁免
                  </a-tag>
                  <a-tag
                    v-if="rule.source && rule.source.kind !== 'manual'"
                    :color="sourceMeta(rule.source.kind).color"
                    class="rule-kind-tag"
                  >
                    {{ sourceMeta(rule.source.kind).label }}
                  </a-tag>
                </div>
                <div class="rule-content" :title="rule.content">{{ rule.content }}</div>
              </div>
              <div class="rule-ops">
                <a-button
                  v-if="rule.source"
                  size="small"
                  type="text"
                  class="rule-expand"
                  @click="toggleRuleExpand(rule.id)"
                >
                  {{ isRuleExpanded(rule.id) ? '收起' : '溯源' }}
                </a-button>
                <a-button size="small" @click="openEditRule(rule)">编辑</a-button>
                <a-popconfirm
                  :title="
                    isSedimentSource(rule.source?.kind)
                      ? '确认删除该规范？关联的治理记录将回归未沉淀状态'
                      : '确认删除该规范？'
                  "
                  @confirm="removeRule(rule)"
                >
                  <a-button size="small" danger>删除</a-button>
                </a-popconfirm>
              </div>
            </div>
            <div v-if="isRuleExpanded(rule.id) && rule.source" class="traceback-panel">
              <div class="traceback-head">
                <span class="traceback-title">沉淀来源快照</span>
                <span class="traceback-meta">
                  沉淀于 {{ dayjs(rule.source.createdAt).format('YYYY-MM-DD HH:mm') }} · 共
                  {{ rule.source.items.length }} 条治理记录（快照不受后续删除影响）
                </span>
              </div>
              <div class="snapshot-list">
                <div
                  v-for="(item, i) in rule.source.items"
                  :key="i"
                  class="snapshot-row"
                >
                  <a-tag :color="snapshotTypeMeta(item.type).color" class="snapshot-type">
                    {{ snapshotTypeMeta(item.type).label }}
                  </a-tag>
                  <span class="snapshot-scope">
                    {{ item.scope === 'general' ? '通用' : item.scope }}
                  </span>
                  <span class="snapshot-file">{{ item.file }}:{{ item.line }}</span>
                  <span class="snapshot-comment" :title="item.comment">{{ item.comment }}</span>
                  <span class="snapshot-time">{{ dayjs(item.recordedAt).format('MM-DD HH:mm') }}</span>
                </div>
              </div>
              <div v-if="isSedimentSource(rule.source?.kind)" class="traceback-foot">
                <a class="traceback-link" @click="goRecords(rule.source?.kind)">去治理记录查看现行状态 →</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <a-modal
      v-model:open="setModalOpen"
      :title="setEditingId ? '重命名规范集' : '新建规范集'"
      ok-text="保存"
      cancel-text="取消"
      @ok="submitSet"
    >
      <a-form layout="vertical">
        <a-form-item label="规范集名称" required>
          <a-input
            v-model:value="setForm.name"
            placeholder="例如：前端团队规范 / 后端 Go 规范"
            allow-clear
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="ruleModalOpen"
      :title="ruleForm.id ? '编辑规范' : '添加规范'"
      ok-text="保存"
      cancel-text="取消"
      @ok="submitRule"
    >
      <a-form layout="vertical">
        <a-form-item label="类型" required>
          <a-radio-group v-model:value="ruleForm.kind">
            <a-radio value="standard">遵守规范</a-radio>
            <a-radio value="exemption">豁免规则</a-radio>
          </a-radio-group>
          <div class="kind-desc">
            {{
              ruleForm.kind === 'exemption'
                ? '豁免规则：AI 评审时不再报告与之相同或实质相似的问题（适合从豁免记录沉淀）。'
                : '遵守规范：AI 评审时逐条对照 diff 核验，违反项会引用该规范名称。'
            }}
          </div>
          <a-alert
            v-if="isSedimentSource(ruleForm.sourceKind)"
            class="source-alert"
            type="info"
            show-icon
            :message="sedimentAlertTitle(ruleForm.sourceKind)"
            description="改名会同步更新治理记录中的沉淀回执，但修改内容不会同步到溯源快照；删除规范后，关联的治理记录将回归未沉淀状态。"
          />
          <a-alert
            v-else-if="ruleForm.sourceKind === 'ai-summary'"
            class="source-alert"
            type="info"
            show-icon
            message="此规范来源于 AI 归纳"
            description="修改仅更新本规范，不影响生成时参考的治理记录。"
          />
        </a-form-item>
        <a-form-item label="规范名称" required>
          <a-input
            v-model:value="ruleForm.name"
            placeholder="例如：TypeScript 严格性规范"
            allow-clear
          />
        </a-form-item>
        <a-form-item label="规范内容" required>
          <a-textarea
            v-model:value="ruleForm.content"
            :rows="8"
            placeholder="逐条列出要求（每行一条），AI 评审时会作为核验清单注入"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.rule-sets {
  padding-top: 12px;
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.sets-side {
  flex-shrink: 0;
  width: 240px;
}

.sets-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.sets-side-title {
  font-size: 13px;
  font-weight: 600;
}

.set-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.set-item {
  padding: 10px 12px;
  border: 1px solid rgba(5, 5, 5, 0.08);
  border-radius: 8px;
  cursor: pointer;
}

.set-item.active {
  border-color: var(--ant-color-success, #52c41a);
  background: rgba(82, 196, 26, 0.06);
}

.set-item-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.set-item-label {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.set-item-count {
  margin-top: 2px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.set-item-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.sets-hint {
  margin: 10px 0 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.rules-main {
  flex: 1;
  min-width: 0;
}

.rule-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.rule-hint {
  margin: 0 0 12px;
  color: var(--ant-color-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}

.rule-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rule-item {
  padding: 8px 10px;
  border: 1px solid rgba(5, 5, 5, 0.08);
  border-radius: 8px;
}

.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rule-row :deep(.ant-switch) {
  flex-shrink: 0;
}

.rule-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.rule-main {
  flex: 1;
  min-width: 0;
}

.rule-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.rule-kind-tag {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.rule-content {
  overflow: hidden;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.kind-desc {
  margin-top: 4px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.5;
}

.source-alert {
  margin-top: 8px;
}

.source-alert :deep(.ant-alert-description) {
  font-size: 12px;
}

.kind-filter {
  margin-left: auto;
}

.rule-expand {
  padding-inline: 4px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.traceback-panel {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(5, 5, 5, 0.12);
}

.traceback-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.traceback-title {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}

.traceback-meta {
  overflow: hidden;
  color: rgba(0, 0, 0, 0.45);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.snapshot-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.snapshot-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.02);
  font-size: 12px;
}

.snapshot-type {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.snapshot-scope {
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  color: rgba(0, 0, 0, 0.65);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.snapshot-file {
  flex-shrink: 0;
  max-width: 220px;
  overflow: hidden;
  color: rgba(0, 0, 0, 0.45);
  font-family: var(--ant-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.snapshot-comment {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgba(0, 0, 0, 0.75);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.snapshot-time {
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.35);
  font-size: 11px;
}

.traceback-foot {
  margin-top: 6px;
  text-align: right;
}

.traceback-link {
  font-size: 12px;
}
</style>
