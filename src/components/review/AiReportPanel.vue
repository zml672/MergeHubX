<script setup lang="ts">
import { computed, ref } from 'vue'
import { Empty } from 'ant-design-vue'
import { useRouter } from 'vue-router'
import {
  AuditOutlined,
  DownOutlined,
  DownloadOutlined,
  MoreOutlined,
  RobotOutlined,
  StopOutlined,
} from '@ant-design/icons-vue'
import { PREV_STATUS_META, severityOptions } from '../../composables/useAiReviewFlow'
import type { AiReviewFlow } from '../../composables/useAiReviewFlow'
import { useReviewExport } from '../../composables/useReviewExport'
import { friendlyAiError } from '../../services/ai'
import { AI_ISSUE_TYPE_META, AI_RISK_META, AI_SEVERITY_META } from '../../types/ai'
import type { AiIssue, IssueDisposition } from '../../types/ai'

const props = defineProps<{
  /** AI 评审流程状态与动作（由视图通过 useAiReviewFlow 创建） */
  flow: AiReviewFlow
  /** 发起评审：本地/远程视图注入各自的开始逻辑（含模式弹窗前置检查） */
  startReview: (force?: boolean) => void
  /** 空状态文案：本地=仓库口径，远程=请求口径 */
  emptyText: string
}>()

const {
  aiHistory,
  historyIndex,
  aiResult,
  setHistoryIndex,
  prevStats,
  summaryStats,
  statLines,
  aiReviewing,
  aiError,
  aiLog,
  aiPanels,
  progressTag,
  progressSummary,
  logStatsText,
  aiHint,
  stopAiReview,
  resumeBatchCount,
  resumeAvailable,
  resumeAiReview,
  stepColor,
  stepDuration,
  formatAiTime,
  severityFilter,
  collapsedIssues,
  collapsedGroups,
  recordOf,
  hiddenExemptCount,
  issueStats,
  issueGroups,
  locatedGroup,
  setIssueGroupEl,
  locateIssueGroup,
  setSeverityFilter,
  issueKeyOf,
  toggleIssue,
  toggleGroup,
  governIssue,
  restoreIssue,
  onIssueCopyMenu,
  onGroupCopyMenu,
  jumpToFileLine,
} = props.flow

/** 导出报告只需 flow 一个依赖，面板内部自行组合 */
const { exportMarkdown } = useReviewExport(props.flow)

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

/** 错误提示友好化：命中常见错误映射时展示建议文案，原始错误移入详情行 */
const friendlyError = computed(() => friendlyAiError(aiError.value))

/** 错误提示详情行：原始错误 + 断点续跑提示（有断点时告知已完成批次与继续入口） */
const errorAlertLines = computed(() => {
  const lines: string[] = []
  if (friendlyError.value !== aiError.value) lines.push(aiError.value)
  if (resumeAvailable.value) {
    lines.push(
      `已完成 ${resumeBatchCount.value} 批分析，点击「继续分析」从断点处继续，避免重复消耗 Token。`,
    )
  }
  return lines
})

/** 错误提示动作：有断点时续跑，否则重试（从头） */
function onErrorAction() {
  if (resumeAvailable.value) resumeAiReview()
  else props.startReview(true)
}

/** 复核摘要明细展开状态：默认只展示一行摘要 */
const verifyExpanded = ref(false)

/** 跳转治理工作台查看豁免记录 */
const router = useRouter()
function openGovernance() {
  void router.push({ path: '/governance', query: { view: 'exempt' } })
}

/** 处置理由采集弹窗：待处置问题与选定的处置方式，确认时随理由一并写入治理记录 */
const governModalOpen = ref(false)
const governReasonInput = ref('')
const pendingGovern = ref<{
  issue: AiIssue
  disposition: IssueDisposition
  scope: string
} | null>(null)

/** 治理菜单点击：打开理由采集弹窗；仅豁免场景预填 AI 复核误报原因（与豁免语义一致），遵守场景留空由用户自行填写 */
function openGovernModal(issue: AiIssue, info: { key: string | number }) {
  const [disposition, scope] = String(info.key).split(':')
  if (disposition !== 'exempt' && disposition !== 'comply') return
  pendingGovern.value = { issue, disposition, scope }
  // 遵守记录意味着认可问题并整改，误报原因作为其处置理由语义矛盾，不预填
  governReasonInput.value = disposition === 'exempt' ? (issue.verifyReason ?? '') : ''
  governModalOpen.value = true
}

/** 确认处置：带理由加入治理，关闭弹窗 */
function confirmGovern() {
  const pending = pendingGovern.value
  if (!pending) return
  governIssue(pending.issue, pending.disposition, pending.scope, governReasonInput.value)
  governModalOpen.value = false
  pendingGovern.value = null
}
</script>

<template>
  <div class="ai-review-layout">
    <section class="ai-result-card">
      <div class="ai-result-head">
        <span class="ai-progress-title">AI 评审报告</span>
        <span class="ai-head-actions">
          <a-select
            v-if="aiResult && aiHistory.length > 0"
            size="small"
            class="ai-history-select"
            :value="historyIndex"
            @change="setHistoryIndex"
          >
            <a-select-option :value="0">当前结果</a-select-option>
            <a-select-option
              v-for="(h, i) in aiHistory"
              :key="h.reviewedAt"
              :value="i + 1"
            >
              历史 · {{ formatAiTime(h.reviewedAt) }}
            </a-select-option>
          </a-select>
          <a-button
            v-if="!aiReviewing && resumeAvailable"
            size="small"
            type="primary"
            @click="resumeAiReview"
          >
            <template #icon><RobotOutlined /></template>
            继续分析
          </a-button>
          <a-button
            v-else-if="!aiReviewing"
            size="small"
            type="primary"
            ghost
            @click="startReview(true)"
          >
            <template #icon><RobotOutlined /></template>
            {{ aiResult ? '重新分析' : '开始评审' }}
          </a-button>
          <a-button
            v-if="!aiReviewing && resumeAvailable"
            size="small"
            @click="startReview(true)"
          >
            从头重新分析
          </a-button>
        </span>
      </div>
      <a-alert
        v-if="aiError && !aiReviewing"
        type="error"
        show-icon
        :message="friendlyError"
      >
        <template v-if="errorAlertLines.length" #description>
          <div v-for="(line, i) in errorAlertLines" :key="i">{{ line }}</div>
        </template>
        <template #action>
          <a-button size="small" @click="onErrorAction">
            {{ resumeAvailable ? '继续分析' : '重试' }}
          </a-button>
        </template>
      </a-alert>
      <template v-else-if="aiLog || aiResult || aiReviewing">
        <a-collapse v-model:activeKey="aiPanels" ghost class="ai-panels">
          <a-collapse-panel v-if="aiLog || aiReviewing" key="progress" header="评审进度">
            <template #extra>
              <span class="ai-panel-extra" @click.stop>
                <a-tag :color="progressTag.color">{{ progressTag.label }}</a-tag>
                <span class="ai-panel-extra-text">{{ progressSummary }}</span>
                <a-button
                  v-if="aiReviewing"
                  size="small"
                  danger
                  @click.stop="stopAiReview"
                >
                  <template #icon><StopOutlined /></template>
                  停止评审
                </a-button>
              </span>
            </template>
            <div class="ai-progress-body">
              <a-alert
                v-if="aiLog?.canceled"
                class="ai-progress-error"
                type="warning"
                show-icon
                message="评审已手动停止"
                description="可点击「重新分析」重新发起评审。"
              />
              <a-alert
                v-else-if="aiLog?.error"
                class="ai-progress-error"
                type="error"
                show-icon
                :message="aiLog?.error || ''"
              />
              <template v-if="!aiLog">
                <a-skeleton active :paragraph="{ rows: 5 }" />
                <div class="ai-state-hint">{{ aiHint }}</div>
              </template>
              <a-timeline v-else class="ai-timeline">
                <a-timeline-item
                  v-for="step in aiLog.steps"
                  :key="step.key"
                  :color="stepColor(step.status)"
                >
                  <div class="ai-step-row">
                    <span class="ai-step-title" :class="`is-${step.status}`">{{ step.title }}</span>
                    <span class="ai-step-time">{{ stepDuration(step) }}</span>
                  </div>
                  <div v-if="step.detail" class="ai-step-detail">{{ step.detail }}</div>
                </a-timeline-item>
              </a-timeline>
              <div
                v-if="aiLog?.done && !aiLog.error && !aiLog.canceled"
                class="ai-log-stats"
              >{{ logStatsText }}</div>
            </div>
          </a-collapse-panel>
          <a-collapse-panel v-if="aiResult" key="result" header="分析结果">
            <template #extra>
              <span class="ai-panel-extra" @click.stop>
                <a-tag v-if="aiReviewing" color="processing">上次结果</a-tag>
                <a-tag class="ai-risk-tag" :color="AI_RISK_META[aiResult.riskLevel].color">
                  {{ AI_RISK_META[aiResult.riskLevel].label }}
                </a-tag>
                <span class="ai-panel-extra-text">{{ formatAiTime(aiResult.reviewedAt) }}</span>
              </span>
            </template>
            <div class="ai-report-head">
              <span class="ai-report-meta">
                核验规范{{ aiResult.ruleSetName ? `「${aiResult.ruleSetName}」` : '' }} {{ aiResult.ruleCount }} 条 · 模型 {{ aiResult.model }}
              </span>
              <span class="ai-report-actions">
                <a-button size="small" @click="exportMarkdown">
                  <template #icon><DownloadOutlined /></template>
                  导出 Markdown
                </a-button>
              </span>
            </div>
            <div class="ai-stat-summary">
              <div class="ai-stat-line">
                本次共分析
                <span class="ai-stat-num">{{ summaryStats.totalFiles }}</span>
                个变更文件，其中
                <span class="ai-stat-num">{{ summaryStats.issueFileCount }}</span>
                个文件发现问题：高风险
                <span class="ai-stat-num is-high">{{ summaryStats.high }}</span> ·
                中风险
                <span class="ai-stat-num is-medium">{{ summaryStats.medium }}</span> ·
                低风险
                <span class="ai-stat-num is-low">{{ summaryStats.low }}</span>
              </div>
              <div
                v-for="line in statLines"
                :key="line.key"
                class="ai-stat-line"
                :class="{ 'is-focus': line.focus }"
              >
                {{ line.label }}：<template
                  v-for="(file, i) in line.files"
                  :key="file"
                ><span
                  class="ai-stat-file"
                  title="点击定位到下方问题清单"
                  @click="locateIssueGroup(file)"
                >{{ file }}</span><template v-if="i < line.files.length - 1">、</template></template>
              </div>
            </div>
            <div v-if="aiResult?.verify" class="ai-verify-line">
              <a class="ai-verify-toggle" @click="verifyExpanded = !verifyExpanded">
                <template v-if="aiResult.verify.failedFiles != null && aiResult.verify.failedFiles > 0">
                  复核调用失败 {{ aiResult.verify.failedFiles }} 个文件，未产出有效复核结论
                </template>
                <template v-else>
                已复核：确认
                <span class="ai-stat-num is-low">{{ aiResult.verify.confirmed }}</span>
                条，过滤
                <span class="ai-stat-num is-medium">{{ aiResult.verify.filtered }}</span>
                条疑似误报<template
                  v-if="aiResult.verify.unverified != null && aiResult.verify.unverified > 0"
                >，未核验
                <span class="ai-stat-num">{{ aiResult.verify.unverified }}</span>
                条</template>
                </template>
                <DownOutlined class="ai-verify-arrow" :class="{ 'is-expanded': verifyExpanded }" />
              </a>
              <div
                v-if="verifyExpanded && aiResult.verify.filteredIssues.length > 0"
                class="ai-verify-detail"
              >
                <div
                  v-for="(issue, i) in aiResult.verify.filteredIssues"
                  :key="`${issue.file}:${issue.line}:${i}`"
                  class="ai-verify-item"
                >
                  <span class="ai-verify-file">{{ issue.file }}:{{ issue.line }}</span>
                  <span class="ai-verify-note">{{ issue.comment }}</span>
                  <span v-if="issue.verifyReason" class="ai-verify-reason">误报原因：{{ issue.verifyReason }}</span>
                </div>
              </div>
            </div>
            <div class="ai-summary">
              <div class="ai-summary-title">模型总评</div>
              {{ aiResult.summary }}
            </div>
            <a-alert
              v-if="aiResult.degraded"
              class="ai-degraded"
              type="warning"
              show-icon
              message="模型未按约定格式返回，以上为其原始输出，可点击「重新分析」重试。"
            />
          </a-collapse-panel>
          <a-collapse-panel
            v-if="aiResult && aiResult.previousChecks && aiResult.previousChecks.length > 0"
            key="compare"
            header="修复对比"
          >
            <template #extra>
              <span class="ai-panel-extra" @click.stop>
                <span class="ai-panel-extra-text">{{ prevStats }}</span>
              </span>
            </template>
            <div
              v-for="(check, i) in aiResult.previousChecks"
              :key="`${check.file}:${check.line}:${i}`"
              class="ai-prev-item"
            >
              <a-tag :color="PREV_STATUS_META[check.status].color">
                {{ PREV_STATUS_META[check.status].label }}
              </a-tag>
              <span
                class="ai-prev-file"
                title="点击定位到文件变更"
                @click="jumpToFileLine(check.file, check.line)"
              >{{ check.file }}:{{ check.line }}</span>
              <span class="ai-prev-note">{{ check.note }}</span>
            </div>
          </a-collapse-panel>
          <a-collapse-panel
            v-if="aiResult && !aiResult.degraded"
            key="issues"
            header="问题清单"
          >
            <template #extra>
              <span class="ai-panel-extra" @click.stop>
                <span class="ai-panel-extra-text">
                  共 {{ issueStats.total }} · 严重 {{ issueStats.high }} · 一般
                  {{ issueStats.medium }} · 轻微 {{ issueStats.low }}
                </span>
              </span>
            </template>
            <div v-if="aiResult.issues.length >= 2" class="ai-issues-toolbar">
              <span class="ai-issues-filters">
                <a-checkable-tag
                  v-for="opt in severityOptions"
                  :key="opt.value"
                  class="ai-severity-filter"
                  :checked="severityFilter === opt.value"
                  @change="setSeverityFilter(opt.value)"
                >
                  {{ opt.label }}
                </a-checkable-tag>
              </span>
            </div>
            <a-alert
              v-if="aiResult.issues.length === 0"
              type="success"
              show-icon
              message="未发现问题"
              description="模型未在该请求的变更中发现明显缺陷、安全隐患或规范违背。"
            />
            <div v-else class="ai-issues">
              <a-empty
                v-if="issueGroups.length === 0"
                :image="simpleImage"
                description="当前筛选下没有匹配的问题"
              />
              <div
                v-for="group in issueGroups"
                :key="group.file"
                :ref="(el) => setIssueGroupEl(group.file, el)"
                class="ai-issue-group"
                :class="{ 'is-located': locatedGroup === group.file }"
              >
                <div class="ai-issue-group-head" @click="toggleGroup(group.file)">
                  <span class="ai-issue-group-title">
                    <span
                      class="ai-issue-group-file"
                      title="点击查看该文件的变更内容"
                      @click.stop="jumpToFileLine(group.file, group.issues[0].line)"
                    >{{ group.file }}</span>
                    <a-dropdown :trigger="['click']">
                      <button
                        class="ai-issue-group-copy"
                        type="button"
                        title="复制文件路径或该文件全部问题"
                        @click.stop
                      >
                        <MoreOutlined />
                      </button>
                      <template #overlay>
                        <a-menu @click="onGroupCopyMenu(group.file, group.issues, $event)">
                          <a-menu-item key="path">复制路径</a-menu-item>
                          <a-menu-item key="all">全部复制</a-menu-item>
                        </a-menu>
                      </template>
                    </a-dropdown>
                  </span>
                  <span class="ai-issue-group-meta">
                    <span v-if="group.high > 0" class="ai-group-count is-high">严重 {{ group.high }}</span>
                    <span v-if="group.medium > 0" class="ai-group-count is-medium">一般 {{ group.medium }}</span>
                    <span v-if="group.low > 0" class="ai-group-count is-low">轻微 {{ group.low }}</span>
                    <DownOutlined
                      class="ai-group-chevron"
                      :class="{ collapsed: collapsedGroups.has(group.file) }"
                    />
                  </span>
                </div>
                <div
                  v-for="(issue, gi) in group.issues"
                  v-show="!collapsedGroups.has(group.file)"
                  :key="`${issue.file}:${issue.line}:${issue.type}:${gi}`"
                  class="ai-issue"
                  :class="{ comply: recordOf(issue)?.disposition === 'comply' }"
                >
                  <div
                    class="ai-issue-head"
                    @click="toggleIssue(issueKeyOf(group.file, gi))"
                  >
                    <a-tag :color="AI_SEVERITY_META[issue.severity].color">
                      {{ AI_SEVERITY_META[issue.severity].label }}
                    </a-tag>
                    <a-tag :color="AI_ISSUE_TYPE_META[issue.type].color">
                      {{ AI_ISSUE_TYPE_META[issue.type].label }}
                    </a-tag>
                    <a-tag v-if="recordOf(issue)?.disposition === 'comply'" color="blue">遵守</a-tag>
                    <a-tag v-if="issue.prevStatus === 'partial'" color="warning">上轮已报·部分修复</a-tag>
                    <a-tag v-else-if="issue.prevStatus === 'not_fixed'" color="error">上轮已报·未修复</a-tag>
                    <span
                      class="ai-issue-file"
                      title="点击定位到文件变更"
                      @click.stop="jumpToFileLine(issue.file, issue.line)"
                    >{{ issue.file }}:{{ issue.line }}</span>
                    <a-dropdown :trigger="['click']">
                      <button
                        class="ai-issue-more"
                        type="button"
                        title="复制文件路径或完整问题信息"
                        @click.stop
                      >
                        <MoreOutlined />
                      </button>
                      <template #overlay>
                        <a-menu @click="onIssueCopyMenu(issue, $event)">
                          <a-menu-item key="path">复制路径</a-menu-item>
                          <a-menu-item key="all">全部复制</a-menu-item>
                        </a-menu>
                      </template>
                    </a-dropdown>
                    <DownOutlined
                      class="ai-issue-chevron"
                      :class="{ collapsed: collapsedIssues.has(issueKeyOf(group.file, gi)) }"
                    />
                    <a-dropdown :trigger="['click']">
                      <button
                        class="ai-issue-waive"
                        type="button"
                        :title="recordOf(issue) ? '该问题已加入治理' : '加入豁免或遵守'"
                        @click.stop
                      >
                        <AuditOutlined />
                      </button>
                      <template #overlay>
                        <a-menu
                          v-if="!recordOf(issue)"
                          @click="openGovernModal(issue, $event)"
                        >
                          <a-menu-item key="exempt:repo">豁免（仅本仓库）</a-menu-item>
                          <a-menu-item key="exempt:general">豁免（通用 · 所有仓库）</a-menu-item>
                          <a-menu-divider />
                          <a-menu-item key="comply:repo">遵守（仅本仓库）</a-menu-item>
                          <a-menu-item key="comply:general">遵守（通用 · 所有仓库）</a-menu-item>
                        </a-menu>
                        <a-menu v-else @click="restoreIssue(issue)">
                          <a-menu-item key="restore">恢复显示（退出治理）</a-menu-item>
                        </a-menu>
                      </template>
                    </a-dropdown>
                  </div>
                  <div
                    v-show="!collapsedIssues.has(issueKeyOf(group.file, gi))"
                    class="ai-issue-body"
                  >
                    <div class="ai-issue-comment">{{ issue.comment }}</div>
                    <div v-if="issue.suggestion" class="ai-issue-suggestion">
                      <span class="ai-issue-suggestion-label">建议修复</span
                      >{{ issue.suggestion }}
                    </div>
                    <div
                      v-if="recordOf(issue)?.disposition === 'comply'"
                      class="ai-issue-comply-note"
                    >
                      该问题已加入遵守记录，提炼为团队规范后 AI 评审将逐条核验。
                      <a-button size="small" type="link" @click="restoreIssue(issue)">
                        退出遵守
                      </a-button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="hiddenExemptCount > 0" class="ai-exempt-footer">
              另有 {{ hiddenExemptCount }} 条问题已豁免隐藏
              <a-button size="small" type="link" @click="openGovernance">前往治理查看 ›</a-button>
            </div>
          </a-collapse-panel>
        </a-collapse>
      </template>
      <div v-else class="ai-state">
        <a-empty :image="simpleImage" :description="emptyText" />
      </div>
    </section>

    <a-modal
      v-model:open="governModalOpen"
      :title="pendingGovern?.disposition === 'comply' ? '加入遵守记录' : '加入豁免'"
      ok-text="确认"
      cancel-text="取消"
      @ok="confirmGovern"
    >
      <div v-if="pendingGovern" class="govern-modal-body">
        <div class="govern-modal-meta">
          <span class="govern-modal-file">
            {{ pendingGovern.issue.file
            }}<template v-if="pendingGovern.issue.line > 0">:{{ pendingGovern.issue.line }}</template>
          </span>
          <span class="govern-modal-scope">
            {{ pendingGovern.scope === 'general' ? '通用 · 所有仓库' : '仅本仓库' }}
          </span>
        </div>
        <a-alert
          v-if="pendingGovern.disposition === 'exempt' && pendingGovern.issue.verifyReason"
          class="govern-modal-alert"
          type="info"
          show-icon
          message="已预填 AI 复核判定的误报原因，可修改或补充"
        />
        <a-textarea
          v-model:value="governReasonInput"
          :rows="3"
          :maxlength="300"
          placeholder="处置理由（选填），便于治理工作台回溯"
        />
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.ai-state {
  padding: 24px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.ai-state-hint {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.ai-review-layout {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-result-card {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 12px 16px;
}

.ai-panels :deep(.ant-collapse-header) {
  padding: 10px 0;
  font-weight: 600;
}

.ai-panels :deep(.ant-collapse-item) {
  border-bottom: 1px solid #f5f5f5;
}

.ai-panel-extra {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 400;
}

.ai-panel-extra-text {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.ai-progress-title {
  font-weight: 600;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.85);
}

.ai-progress-body {
  margin-top: 12px;
  padding-top: 4px;
}

.ai-progress-error {
  margin-bottom: 12px;
}

.ai-timeline {
  margin: 0;
  padding-left: 2px;
}

.ai-step-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ai-step-title {
  font-size: 13px;
  color: rgba(0, 0, 0, 0.45);
}

.ai-step-title.is-running {
  color: #1677ff;
  font-weight: 600;
}

.ai-step-title.is-done {
  color: rgba(0, 0, 0, 0.85);
}

.ai-step-title.is-error {
  color: #cf1322;
  font-weight: 600;
}

.ai-step-time {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.ai-step-detail {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  margin-top: 2px;
}

.ai-log-stats {
  margin-top: 12px;
  padding: 8px 12px;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
  border-radius: 6px;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
}

.ai-result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.ai-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ai-report-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.ai-risk-tag {
  margin-inline-end: 0;
  font-weight: 600;
}

.ai-report-meta {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}

.ai-report-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.ai-stat-summary {
  padding: 12px 16px;
  background: #f0f7ff;
  border: 1px solid #d6e8ff;
  border-radius: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  line-height: 1.9;
  color: rgba(0, 0, 0, 0.85);
}

.ai-stat-line {
  word-break: break-all;
}

.ai-stat-line.is-focus {
  font-weight: 600;
}

.ai-stat-file {
  color: #1677ff;
  cursor: pointer;
  word-break: break-all;
}

.ai-stat-file:hover {
  text-decoration: underline;
}

.ai-stat-num {
  font-weight: 600;
  margin: 0 2px;
}

.ai-stat-num.is-high {
  color: #cf1322;
}

.ai-stat-num.is-medium {
  color: #d46b08;
}

.ai-stat-num.is-low {
  color: #389e0d;
}

.ai-summary-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.ai-summary {
  padding: 12px 16px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.7;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.85);
}

.ai-history-select {
  min-width: 132px;
}

.ai-prev-item {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
}

.ai-prev-item + .ai-prev-item {
  border-top: 1px dashed #f0f0f0;
}

.ai-prev-file {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  color: rgba(0, 0, 0, 0.65);
  word-break: break-all;
  flex: 1 1 200px;
  min-width: 0;
  cursor: pointer;
}

.ai-prev-file:hover {
  color: #1677ff;
}

.ai-prev-note {
  color: rgba(0, 0, 0, 0.85);
  line-height: 1.6;
  word-break: break-word;
  flex: 1 1 100%;
  min-width: 0;
}

.ai-verify-line {
  padding: 8px 16px;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
  border-radius: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.85);
}

.ai-verify-toggle {
  color: rgba(0, 0, 0, 0.85);
  cursor: pointer;
  user-select: none;
}

.ai-verify-toggle:hover {
  color: #1677ff;
}

.ai-verify-arrow {
  font-size: 10px;
  color: rgba(0, 0, 0, 0.45);
  margin-left: 4px;
  transition: transform 0.2s;
}

.ai-verify-arrow.is-expanded {
  transform: rotate(180deg);
}

.ai-verify-detail {
  margin-top: 4px;
  border-top: 1px dashed #d9f7be;
  padding-top: 2px;
}

.ai-verify-item {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0;
  font-size: 12px;
}

.ai-verify-item + .ai-verify-item {
  border-top: 1px dashed #f0f0f0;
}

.ai-verify-file {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  color: rgba(0, 0, 0, 0.65);
  word-break: break-all;
  flex: 1 1 200px;
  min-width: 0;
}

.ai-verify-note {
  color: rgba(0, 0, 0, 0.85);
  line-height: 1.6;
  word-break: break-word;
  flex: 1 1 100%;
  min-width: 0;
}

.ai-verify-reason {
  color: rgba(0, 0, 0, 0.55);
  line-height: 1.6;
  word-break: break-word;
  flex: 1 1 100%;
  min-width: 0;
}

.ai-degraded {
  margin-top: 12px;
}

.ai-issues {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-issue-group {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 8px 12px 10px;
  background: #fff;
  scroll-margin-top: 12px;
}

.ai-issue-group + .ai-issue-group {
  margin-top: 4px;
}

.ai-issue-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 6px;
  margin-bottom: 8px;
  border-bottom: 1px dashed #f0f0f0;
  cursor: pointer;
  user-select: none;
}

.ai-group-chevron {
  margin-left: 4px;
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.25);
  font-size: 12px;
  transition: transform 0.2s, color 0.2s;
}

.ai-issue-group-head:hover .ai-group-chevron {
  color: rgba(0, 0, 0, 0.65);
}

.ai-group-chevron.collapsed {
  transform: rotate(-90deg);
}

.ai-issue-group-file {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  font-weight: 600;
  color: #1677ff;
  word-break: break-all;
  cursor: pointer;
}

.ai-issue-group-file:hover {
  text-decoration: underline;
}

.ai-issue-group-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ai-issue-group-copy {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(0, 0, 0, 0.35);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s, background 0.2s;
}

.ai-issue-group-copy:hover {
  color: #1677ff;
  background: rgba(22, 119, 255, 0.08);
}

.ai-issue-group-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.ai-group-count {
  font-size: 12px;
  line-height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  background: #f5f5f5;
  color: rgba(0, 0, 0, 0.65);
}

.ai-group-count.is-high {
  background: #fff1f0;
  color: #cf1322;
}

.ai-group-count.is-medium {
  background: #fff7e6;
  color: #d46b08;
}

.ai-group-count.is-low {
  background: #f6ffed;
  color: #389e0d;
}

.ai-issue-group.is-located {
  animation: issue-group-flash 1.6s ease-out;
}

@keyframes issue-group-flash {
  from {
    background: #e6f4ff;
    border-color: #91caff;
  }
  to {
    background: #fff;
    border-color: #f0f0f0;
  }
}

.ai-issue {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 10px 12px;
}

.ai-issue + .ai-issue {
  margin-top: 8px;
}

.ai-issue-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  cursor: pointer;
  user-select: none;
}

.ai-issue-file {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
  word-break: break-all;
  cursor: pointer;
}

.ai-issue-file:hover {
  color: #1677ff;
}

.ai-issue-comment {
  margin-top: 6px;
  line-height: 1.7;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgba(0, 0, 0, 0.85);
}

.ai-issue.comply {
  background: #f0f7ff;
}

.ai-issue-comply-note {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #d6e8ff;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-exempt-footer {
  margin-top: 12px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px dashed #f0f0f0;
  border-radius: 6px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.ai-issues-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.ai-issues-filters {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ai-severity-filter {
  cursor: pointer;
}

.ai-issue-chevron {
  margin-left: auto;
  flex-shrink: 0;
  color: rgba(0, 0, 0, 0.25);
  font-size: 12px;
  transition: transform 0.2s, color 0.2s;
}

.ai-issue-head:hover .ai-issue-chevron {
  color: rgba(0, 0, 0, 0.65);
}

.ai-issue-chevron.collapsed {
  transform: rotate(-90deg);
}

.ai-issue-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai-issue-suggestion {
  background: #f6f8fa;
  border-left: 3px solid #1677ff;
  padding: 6px 10px;
  border-radius: 0 6px 6px 0;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(0, 0, 0, 0.75);
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-issue-suggestion-label {
  color: #1677ff;
  font-weight: 600;
  margin-right: 8px;
}

.ai-issue-waive {
  width: 22px;
  height: 22px;
  margin-left: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(0, 0, 0, 0.35);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s, background 0.2s;
}

.ai-issue-waive:hover {
  color: #1677ff;
  background: rgba(22, 119, 255, 0.08);
}

.ai-issue-more {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(0, 0, 0, 0.35);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s, background 0.2s;
}

.ai-issue-more:hover {
  color: #1677ff;
  background: rgba(22, 119, 255, 0.08);
}

.govern-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.govern-modal-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.govern-modal-file {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.65);
  word-break: break-all;
}

.govern-modal-scope {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  background: #f5f5f5;
  color: rgba(0, 0, 0, 0.65);
}

.govern-modal-alert {
  margin-bottom: 0;
}
</style>
