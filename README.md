<div align="center">

# MergeHub

**一个纯本地的 AI 代码审阅工作台**

远程 PR（GitHub / GitLab / Gitee）和本地仓库的未提交变更，都能交给 AI 审一遍。
没有服务端、不用注册登录，代码永远不出你的电脑；模型用自己的 API Key，用哪家、花多少钱，都由你决定。

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Ant Design Vue](https://img.shields.io/badge/Ant_Design_Vue-4.2-1677FF?logo=antdesign&logoColor=white)

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
- **自带 Key（BYOK）**：DeepSeek、Kimi、通义千问、智谱 GLM、Ollama 本地模型开箱即用，也支持任意 OpenAI 兼容端点
- **预算优先 / 全量分析**两种模式：大 diff 自动分块，锁文件与构建产物自动排除，成本可控
- 批次并发可调，回答流式输出，随时可取消
- **断点续跑**：评审中途失败，从断点继续即可——已完成的批次直接复用，不重复调用模型、不重复计费
- **对抗式复核**：对报过问题的文件做第二遍全文取证核对，自动剔除误报
- **历史对比**：与上一轮评审逐条对照，标记「已修复 / 部分修复 / 未修复」；问题清单内直接标注「上轮已报」角标，未修复的问题由系统保证不缺席
- 问题按类型（bug / 安全 / 性能 / 风格 / 规范）与严重度分级，可筛选、定位到 diff 行、单条或批量豁免
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
- Node.js ≥ 18、npm
- Rust（含 cargo）与 [Tauri 2 系统依赖](https://tauri.app/start/prerequisites/)
- 本地仓库功能需要系统已安装 **git**

### 开发运行

```bash
npm install
npm run tauri dev
```

> 只想调试前端页面可以 `npm run dev`，但 Tauri 命令不可用，功能不完整。

### 构建发布

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。

## 🧭 界面导览

| 页面 | 说明 |
|---|---|
| 总览 | 待审阅统计、仓库卡片与最近评审入口 |
| 审阅 | 远程 PR / 本地仓库双视图，评审主战场 |
| 治理 | 规则集与豁免记录的管理与 AI 归纳 |
| 设置（弹窗） | 平台账号、AI 模型、规则集、调试日志 |

## 🏗️ 技术架构

前端 **Vue 3 + TypeScript（strict）+ Pinia + Ant Design Vue**，桌面壳 **Tauri 2**。分层单向依赖，视图层不直接调用 Tauri 命令：

```
src/
├── views/          # 总览 / 远程审阅 / 本地审阅 / 治理
├── components/     # AI 报告、Diff 卡片、模式弹窗、设置分区、治理面板
├── composables/    # 评审流程状态机、导出、分组
├── stores/         # Pinia：设置 / PR / 本地仓库 / AI / 规则 / 豁免 / 界面
├── services/
│   ├── platforms/  # GitHub / GitLab / Gitee API 适配
│   ├── local/      # 本地 git、系统操作
│   ├── ai.ts       # 评审引擎：分块、批次、流式解析、断点指纹
│   ├── http.ts     # 经 Rust 代理的 HTTP / 流式请求
│   └── secret.ts   # 系统凭据管理器读写
├── types/
└── utils/          # 无依赖纯工具（问题指纹：跨层共用的精确匹配键）

src-tauri/src/
├── commands.rs     # HTTP 代理（流式 / 取消）、凭据、AI 日志
└── git.rs          # 本地 git：diff / commit / branches / checkout
```

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

许可证全文见 [LICENSE](LICENSE)，第三方依赖的开源许可证清单见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
