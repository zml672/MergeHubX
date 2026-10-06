<script setup lang="ts">
import { onActivated } from 'vue'
import { useRoute } from 'vue-router'
import LocalReviewView from './LocalReviewView.vue'
import RemoteReviewView from './RemoteReviewView.vue'
import { useReviewGroup } from '../composables/useReviewGroup'

defineOptions({ name: 'ReviewView' })

const route = useRoute()
const { activeGroup, setGroup } = useReviewGroup()

// 按工作台跳转参数预设分组：?platform= 定位远程、?local= 定位本地；无参数时保留上次选择
function applyGroupQuery() {
  if (route.query.platform !== undefined) setGroup('remote')
  else if (route.query.local !== undefined) setGroup('local')
}

applyGroupQuery()

// 路由级 KeepAlive 保活恢复时 setup 不会重跑，跳转参数需在此重新应用
onActivated(applyGroupQuery)
</script>

<template>
  <KeepAlive>
    <RemoteReviewView v-if="activeGroup === 'remote'" />
    <LocalReviewView v-else />
  </KeepAlive>
</template>
