import { createRouter, createWebHashHistory } from 'vue-router'
import ReviewView from '../views/ReviewView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('../views/DashboardView.vue'),
      meta: { title: '总览' },
    },
    {
      path: '/review',
      name: 'review',
      component: ReviewView,
      meta: { title: '审阅' },
    },
    {
      path: '/governance',
      name: 'governance',
      component: () => import('../views/GovernanceView.vue'),
      meta: { title: '治理' },
    },
  ],
})

export default router
