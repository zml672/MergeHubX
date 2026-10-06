import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue()],

  // 单元测试（P0-1）：仅覆盖纯函数与 store 归一化逻辑，不追求 UI 测试覆盖。
  // 默认 node 环境（纯函数测试零 DOM 启动开销）；需要 localStorage/DOM 的测试
  // 在文件头用 // @vitest-environment jsdom 显式声明
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },

  build: {
    rollupOptions: {
      output: {
        // 三方依赖按层拆分：框架/组件库为稳定缓存层，业务迭代不触发其产物哈希变化
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("ant-design-vue") || id.includes("@ant-design")) {
            return "antd";
          }
          if (
            id.includes("/vue") ||
            id.includes("@vue") ||
            id.includes("pinia")
          ) {
            return "vue-vendor";
          }
          return "vendor";
        },
      },
    },
    // antd 为 app.use(Antd) 全量注册，无法 tree-shake，独立 chunk 体积在预期内
    chunkSizeWarningLimit: 2000,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
