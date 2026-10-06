// 构建前清理上一轮打包产物（src-tauri/target/release/bundle），保证 bundle 下只留当轮有效产物
// 由 tauri.conf.json 的 beforeBuildCommand 调用；用 Node 实现保证 Windows/macOS/Linux 三平台通用
import { rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundleDir = join(here, '..', 'src-tauri', 'target', 'release', 'bundle')

if (existsSync(bundleDir)) {
  try {
    rmSync(bundleDir, { recursive: true, force: true })
    console.log('[clean-bundle] 已清理上一轮产物:', bundleDir)
  } catch (err) {
    // Windows 下产物目录常见文件锁（资源管理器开着安装包/杀毒扫描/上次构建进程未退净），
    // 不捕获会抛原始堆栈让 beforeBuildCommand 死得不明不白；此处给出可行动的定位信息后终止
    const reason = err instanceof Error ? err.message : String(err)
    console.error('[clean-bundle] 清理产物目录失败:', bundleDir)
    console.error('[clean-bundle] 原因:', reason)
    console.error(
      '[clean-bundle] 请检查目录是否被占用（资源管理器/杀毒软件/残留构建进程），处理后重试。',
    )
    process.exit(1)
  }
} else {
  console.log('[clean-bundle] 无历史产物，跳过')
}
