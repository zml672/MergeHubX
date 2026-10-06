<script setup lang="ts">
import type { AiReviewFlow } from '../../composables/useAiReviewFlow'
import { useReviewGroup } from '../../composables/useReviewGroup'

const props = defineProps<{
  /** AI 评审流程状态与动作（由视图通过 useAiReviewFlow 创建） */
  flow: AiReviewFlow
}>()

const { modeModalOpen, pendingMode, modePreview, confirmMode } = props.flow
/** 本地视图的评审范围提示：直接读分组单例，无需视图额外传参 */
const { activeGroup } = useReviewGroup()
</script>

<template>
  <a-modal
    v-model:open="modeModalOpen"
    title="选择 AI 分析模式"
    :width="520"
    ok-text="开始分析"
    cancel-text="取消"
    @ok="confirmMode"
  >
    <a-radio-group v-model:value="pendingMode" class="mode-options">
      <a-radio value="budget" class="mode-option">
        <div class="mode-option-body">
          <div class="mode-option-title">按预算分析（推荐）</div>
          <div class="mode-option-desc">
            单文件最多分析约 32KB diff（超出部分截断，绝不整体跳过文件），速度更快、token 消耗相对可控。<template
              v-if="modePreview"
            >预计拆分 {{ modePreview.budget.batches }} 批，纳入
            {{ modePreview.budget.analyzedFiles }} 个文件<template
                v-if="modePreview.budget.excludedFiles > 0"
              >，{{ modePreview.budget.excludedFiles }} 个文件未纳入分析</template>。</template>
          </div>
        </div>
      </a-radio>
      <a-radio value="full" class="mode-option">
        <div class="mode-option-body">
          <div class="mode-option-title">全量分析</div>
          <div class="mode-option-desc">
            不限制单文件大小与批次数，全部代码变更都会得到分析，token 消耗较大。<template
              v-if="modePreview"
            >预计拆分 {{ modePreview.full.batches }} 批，纳入
            {{ modePreview.full.analyzedFiles }} 个文件<template
                v-if="modePreview.full.excludedFiles > 0"
              >，{{ modePreview.full.excludedFiles }} 个文件未纳入分析</template>。</template>
          </div>
        </div>
      </a-radio>
    </a-radio-group>
    <p v-if="activeGroup === 'local'" class="mode-hint">
      评审范围为当前工作区全部变更文件（不受勾选影响），勾选仅决定提交范围。
    </p>
    <p class="mode-hint">
      两种模式都不会整体跳过任何有 diff 的文件，仅自动生成/锁定文件与无文本 diff 的文件不参与评审；全量模式适合重要变更，耗时随批次线性增长。
    </p>
  </a-modal>
</template>

<style scoped>
.mode-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mode-option {
  display: flex;
  align-items: flex-start;
}

.mode-option-body {
  font-size: 13px;
  line-height: 1.6;
}

.mode-option-title {
  font-weight: 600;
}

.mode-option-desc {
  color: rgba(0, 0, 0, 0.55);
  font-size: 12px;
}

.mode-hint {
  margin: 14px 0 0;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
</style>
