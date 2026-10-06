import { ref } from 'vue'

export type ReviewGroup = 'remote' | 'local'

/** 左侧一级分组单例状态：远程仓库（GitHub/GitLab/Gitee）/ 本地仓库。
 * 两个评审子视图（Remote/LocalReviewView）共用同一份分组状态，切换即互斥渲染 */
const activeGroup = ref<ReviewGroup>('local')

export const reviewGroupOptions = [
  { value: 'remote', label: '远程仓库' },
  { value: 'local', label: '本地仓库' },
]

export function useReviewGroup() {
  function setGroup(group: ReviewGroup) {
    activeGroup.value = group
  }
  return { activeGroup, setGroup }
}
