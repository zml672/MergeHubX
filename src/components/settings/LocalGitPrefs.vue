<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings'

const settings = useSettingsStore()

/** 单选切换推送目标策略：对事件值做字面量收窄后再写入 store */
function onModeChange({ target }: { target: { value: string } }) {
  if (target.value === 'same-name' || target.value === 'ask') {
    settings.setPushMode(target.value)
  }
}
</script>

<template>
  <div>
    <p class="local-hint">
      「提交&推送」会把勾选的变更提交到本地仓库，再推送到所选远程仓库
      （默认 origin，多远程时可在工作台标签处点击切换）的目标分支。推送目标按「本地分支 →
      远端分支」显式指定，不受 Git 跟踪配置（upstream / push.default）影响；远端没有目标分支时会自动创建。
    </p>
    <a-radio-group :value="settings.pushMode" @change="onModeChange">
      <div class="mode-list">
        <div class="mode-option">
          <a-radio value="same-name">默认（同名分支）</a-radio>
          <div class="mode-desc">一键提交并推送到所选远程（默认 origin）的同名分支，正常场景无需额外确认。</div>
        </div>
        <div class="mode-option">
          <a-radio value="ask">每次询问</a-radio>
          <div class="mode-desc">
            推送前弹框确认推送远程与远端分支：远程默认填入最后用过或 origin，分支默认填入最后用过或同名的分支，可输入任意分支名；推送成功的「远程 +
            分支」组合会记入历史，可在下拉中选择或删除。
          </div>
        </div>
      </div>
    </a-radio-group>
    <a-alert
      class="local-note"
      type="info"
      show-icon
      message="推送被远端拒绝（远端存在本地没有的提交）时，会提示在终端执行 git pull --rebase 同步后重试；本工具不内置拉取与强制推送。"
    />
  </div>
</template>

<style scoped>
.local-hint {
  margin: 0 0 12px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.6;
}

.mode-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mode-option {
  padding: 10px 12px;
  border: 1px solid rgba(5, 5, 5, 0.08);
  border-radius: 8px;
}

.mode-desc {
  margin-top: 4px;
  padding-left: 24px;
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  line-height: 1.6;
}

.local-note {
  margin-top: 12px;
}
</style>
