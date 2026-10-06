<div align="center">

# MergeHub

**一个纯本地的 AI 代码审阅工作台**

远程 PR（GitHub / GitLab / Gitee）和本地仓库的未提交变更，都能交给 AI 审一遍。
没有服务端、不用注册登录，代码永远不出你的电脑；模型用自己的 API Key，用哪家、花多少钱，都由你决定。

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Ant Design Vue](https://img.shields.io/badge/Ant_Design_Vue-4.2-1677FF?logo=antdesign&logoColor=white)
![License](https://img.shields.io/badge/License-Apache_2.0-blue)
![Version](https://img.shields.io/badge/version-0.1.0-lightgrey)

</div>

## ✨ 功能特性

### 🔀 远程仓库审阅
- 支持 **GitHub / GitLab / Gitee**，填一个 Token 即配即用
- 关注仓库分组管理，PR 列表自动轮询刷新
- Diff 逐文件展开审阅，PR 可一键在浏览器打开平台原页面

### 📁 本地仓库审阅
- 选个文件夹就是仓库，不需要克隆
- 分支查看与切换，工作区变更实时刷新
- 一键提交，支持 **AI 生成 commit message**
- 快速打开仓库所在文件夹

### 🤖 AI 评审
- **自带 Key（BYOK）**：DeepSeek、Kimi、通义千问（阿里云百炼）、智谱 GLM、Ollama 本地模型开箱即用，也支持任意 OpenAI 兼容端点
- **预算优先 / 全量分析**两种模式：大 diff 自动分块，锁文件与构建产物自动排除，成本可控
- 批次并发可调，回答流式输出，随时可取消
- **断点续跑**：评审中途失败，从断点继续即可——已完成的批次直接复用，不重复调用模型、不重复计费
- **对抗式复核**：对报过问题的文件做第二遍全文取证核对，自动剔除误报
- **历史对比**：与上一轮评审逐条对照，标记「已修复 / 部分修复 / 未修复」；问题清单内直接标注「上轮已报」角标，未修复的问题由系统保证不缺席
- 问题按类型（缺陷 / 安全 / 性能 / 风格 / 规范）与严重度分级，可筛选、定位到 diff 行、单条或批量豁免
- 评审报告一键导出 Markdown；每次请求与响应都有完整调试日志，问题可追溯

### 🧠 AI 治理中心
- 把评审经验沉淀成规则：AI 自动归纳豁免草稿，确认后存入规则集
- 豁免的问题会在后续评审的提示词中屏蔽，同样的误报不再出现
- 多套规则集自由切换，通用规范与仓库专属规则分层生效

### 🔒 安全与隐私
- **纯客户端架构**：无服务端、无账号体系，数据与请求全程不出本机
- 平台 Token 存入**系统原生凭据管理器**（如 Windows 凭据管理器），不落明文文件
- 所有网络请求经 Rust 侧代理转发，网页层不直接发起 HTTP

## 🚀 快速开始

### 环境要求
- **Node.js ≥ 18** 与 npm
- **Rust**（含 cargo）与 [Tauri 2 系统依赖](https://tauri.app/start/prerequisites/)
- 本地仓库功能需要系统已安装 **git**

### 开发运行

```bash
npm install
npm run tauri dev
```

> 只想调试前端页面可以 `npm run dev`，但 Tauri 命令不可用，功能不完整。

Windows 下可直接双击根目录的 `dev.cmd`（已内置 `chcp 65001`，中文正常显示）。

### 单元测试

```bash
npm test
```

覆盖评审引擎、分块、提示词、历史对比、误报复核、凭据存储与各 Pinia store 的关键逻辑。Windows 下可双击 `test.cmd`。

### 提交前检查（pre-commit）

仓库自带一个 pre-commit 钩子，提交前会扫描密钥、令牌、私钥与泄漏的本机绝对路径。
克隆后执行一次即可启用：

```bash
git config core.hooksPath scripts/hooks
```

命中高危内容会直接阻止提交；确认安全时可用 `git commit --no-verify` 绕过。

### 构建发布

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。构建前会由 `scripts/clean-bundle.mjs`
自动清理上一轮产物，保证目录里只有当轮有效安装包。

## 🧭 界面导览

| 页面 | 说明 |
|---|---|
| 总览 | 待审阅统计、仓库卡片与最近评审入口 |
| 审阅 | 远程 PR / 本地仓库双视图，评审主战场 |
| 治理 | 规则集与豁免记录的管理与 AI 归纳 |
| 设置（弹窗） | 平台账号、AI 模型、本地 git 偏好、规则集、调试日志 |

## 🏗️ 技术架构

前端 **Vue 3 + TypeScript（strict）+ Pinia + Ant Design Vue**，桌面壳 **Tauri 2**。分层单向依赖：**自定义命令（`invoke`）只出现在 `services/` 层**，视图与组件不直接 `invoke`；仅有少量 UI 级插件 API（打开外部链接 `plugin-opener`、系统文件对话框 `plugin-dialog`）在视图内直接使用。

```
src/
├── main.ts         # 入口：挂载 Vue，注册 Pinia / 路由 / Ant Design Vue
├── App.vue         # 根组件
├── vite-env.d.ts   # Vite 环境类型声明
├── views/          # DashboardView 总览、ReviewView 审阅（内含 RemoteReviewView
│                   #   远程 / LocalReviewView 本地双视图）、GovernanceView 治理
├── layouts/        # MainLayout：侧边导航 + 内容区骨架
├── components/
│   ├── review/     # AiReportPanel 报告面板、DiffFileCard Diff 卡片、
│   │               #   ReviewModeModal 评审模式弹窗、CommitButton 提交按钮
│   ├── governance/ # RuleSets 规则集、GovernanceRecords 豁免记录
│   └── settings/   # SettingsPanel 设置面板：PlatformAccounts 平台账号、
│                   #   AiModels AI 模型、LocalGitPrefs 本地 git、AiDebugLog 调试日志
├── composables/    # useAiReviewFlow 评审流程状态机、useReviewExport 导出、useReviewGroup 分组
├── stores/         # Pinia：settings / prs / watchlist / localRepos / localReview /
│                   #         ai / reviewRules / governanceIssues / ui
├── services/       # 自定义命令（invoke）只出现在这一层
│   ├── ai/         # 评审引擎：engine 编排、batching 分块、client 调用、
│   │               #           prompts 提示词、verify 复核、merge 历史对比、
│   │               #           governance 规则归纳、commit 提交信息、errors 错误友好化
│   ├── platforms/  # GitHub / GitLab / Gitee API 适配
│   ├── local/      # 本地 git 与系统操作
│   ├── http.ts     # 经 Rust 代理的 HTTP / 流式请求
│   ├── secret.ts   # 系统凭据管理器读写
│   ├── storage.ts  # localStorage 持久化
│   └── aiDebugLog.ts
├── types/          # ai / local / platform 类型定义
├── utils/          # 无依赖纯工具（issueFingerprint 问题指纹：跨层共用的精确匹配键）
├── router/         # 路由（hash history）
└── styles/         # main.css 全局样式、review-shared.css 评审共用样式

src-tauri/src/
├── commands.rs     # 9 个命令：HTTP 代理（请求 / 流式 / 取消）、系统凭据（set / get / delete）、
│                   #   AI 日志追加与日志目录打开、本地文件夹打开
├── git.rs          # 8 个命令：仓库信息、diff、commit、分支列表、切换分支、
│                   #   push、remote 列表、读取工作区文件
├── lib.rs          # 应用装配、注册全部 17 个命令、WebView 数据目录
└── main.rs         # 二进制入口
```

> 单元测试以 `__tests__/` 就近放在各层（`services/`、`stores/`、`utils/`），与对应模块一起演进；运行方式见上方「单元测试」。

## 📂 数据存储位置

| 数据 | 位置 |
|---|---|
| 平台 Token | 系统凭据管理器（服务名 `mergehub`） |
| 关注仓库、规则集、豁免记录等配置 | 本地 localStorage |
| WebView 数据 | 系统应用数据目录，可用环境变量 `MERGEHUB_WEBVIEW_DATA` 覆盖 |
| AI 调试日志 | 应用数据目录（设置中可一键打开） |

## 📄 License

本项目采用 **Apache License 2.0** 发布，可自由用于商业项目。

```
Copyright 2026 blackzs

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

许可证全文见 [LICENSE](LICENSE)，版权归属见 [NOTICE](NOTICE)，
第三方依赖的开源许可证清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
