import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Antd from 'ant-design-vue'
import App from './App.vue'
import router from './router'
import { bootstrapStorage } from './services/storage'
import 'ant-design-vue/dist/reset.css'
import './styles/main.css'

async function main(): Promise<void> {
  // P1-17：文件存储预热 + 一次性迁移必须先于 Pinia 初始化——store 的同步
  // state 初始化器依赖门面缓存已就位。两重兜底保证 mount 必达：
  // ① catch：预热抛错 → 门面置写保护，空缓存回退默认值（不覆盖磁盘数据）；
  // ② 超时：invoke 长时间不返回（磁盘挂起等）时 5s 后强制放行，宁可界面空数据
  //    也不白屏——预热完成晚于 mount 时门面缓存为空，语义与「数据缺失」一致
  try {
    await Promise.race([
      bootstrapStorage(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('存储预热超时')), 5000),
      ),
    ])
  } catch (err) {
    console.warn('[mergehub] 存储预热失败/超时，本次启动使用空缓存', err)
  }
  createApp(App).use(createPinia()).use(router).use(Antd).mount('#app')
}

void main()
