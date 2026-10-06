<script setup lang="ts">
/** 提交&推送 按钮统一片段：主按钮执行"提交并推送"；下拉弹层去卡片化（无白底/阴影/内边距），内容为与主按钮等大同款的「仅提交」按钮；详情页 header 与提交条折叠/展开态三处复用 */
// 注意：#overlay template 内禁止写 HTML 注释——slot 数组首元素若是注释 vnode，antd Dropdown 的 renderOverlay 取 overlay[0] 作为弹层内容，整个弹层会渲染成空注释
// 同理 overlay 根必须是 Menu 类组件：antd 会向 overlay 根注入 prefixCls(ant-dropdown-menu) 等 props，Button 也会消费 prefixCls 生成类名，裸放 Button 会被改写成 menu 类导致 primary 样式全失效（白底白字文字不可见）
import { onMounted, ref } from 'vue'

defineProps<{
  /** 是否禁用（工作区无待提交变更时） */
  disabled: boolean
  /** 提交进行中 loading 态 */
  loading: boolean
}>()
// 主按钮 click / mousedown.prevent 经 attrs 透传到 a-dropdown-button 的主动作按钮；弹层按钮点击冒泡至菜单项经 key 分发 emit，点击后 rc-dropdown 自动收起弹层（非受控）
const emit = defineEmits<{ (e: 'commitOnly'): void }>()

// 挂载后实测下拉按钮根元素实际宽度（主按钮+下拉箭头）：弹层内按钮宽=实测宽即与主按钮完全等宽（高度同为 small 24px）
const rootRef = ref<{ $el: HTMLElement } | null>(null)
const mainWidth = ref(0)

onMounted(() => {
  const el = rootRef.value?.$el
  if (el) mainWidth.value = el.offsetWidth
})

function onMenuClick({ key }: { key: string | number }) {
  if (key === 'commit-only') emit('commitOnly')
}
</script>

<template>
  <a-dropdown-button
    ref="rootRef"
    type="primary"
    size="small"
    :disabled="disabled"
    :loading="loading"
    overlay-class-name="commit-only-overlay"
  >
    提交&推送
    <template #overlay>
      <a-menu class="commit-only-menu" @click="onMenuClick">
        <a-menu-item key="commit-only" class="commit-only-menu-item">
          <a-button
            type="primary"
            size="small"
            block
            :style="mainWidth ? { width: `${mainWidth}px` } : undefined"
          >
            仅提交
          </a-button>
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown-button>
</template>

<!-- 弹层容器挂载在组件外（rc-trigger 弹层根元素 .ant-dropdown），overlayClassName 需全局选择器命中；antd cssinjs 运行时注入晚于打包样式，关键视觉属性加 !important 确保覆盖 -->
<style>
.commit-only-overlay {
  padding: 0 !important;
  background: transparent !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

.commit-only-overlay .ant-dropdown-menu.commit-only-menu {
  min-width: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

.commit-only-overlay .ant-dropdown-menu-item.commit-only-menu-item {
  margin: 0 !important;
  padding: 0 !important;
  height: auto !important;
  line-height: normal !important;
}

.commit-only-overlay .ant-dropdown-menu-item.commit-only-menu-item:hover,
.commit-only-overlay .ant-dropdown-menu-item.commit-only-menu-item:focus {
  background: transparent !important;
}
</style>
