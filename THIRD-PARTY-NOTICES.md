# Third-party notices

MergeHubX 使用了以下第三方开源组件。各组件的版权归其各自作者所有，并按其
自身许可证条款授权使用。

本文件仅列出**直接依赖**（direct dependencies）。传递依赖的许可证信息可通过
`npm ls` 与 `cargo tree` 查看。

## 运行时依赖 — 前端（npm）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| @ant-design/icons-vue | 7.0.1 | MIT |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.7.3 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-fs | 2.5.2 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | 2.5.5 | MIT OR Apache-2.0 |
| ant-design-vue | 4.2.6 | MIT |
| pinia | 4.0.3 | MIT |
| vue | 3.5.42 | MIT |
| vue-router | 4.6.4 | MIT |

## 运行时依赖 — 桌面端（Rust / Cargo）

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| tauri | 2.11.5 | Apache-2.0 OR MIT |
| tauri-plugin-dialog | 2.7.3 | Apache-2.0 OR MIT |
| tauri-plugin-fs | 2.5.2 | Apache-2.0 OR MIT |
| tauri-plugin-opener | 2.5.5 | Apache-2.0 OR MIT |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| reqwest | 0.12.28 | MIT OR Apache-2.0 |
| keyring | 3.6.3 | MIT OR Apache-2.0 |
| tokio | 1.53.1 | MIT |
| tokio-util | 0.7.19 | MIT |

## 构建期依赖（devDependencies）

构建期依赖不随产物分发，此处列出仅为完整性。

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| @tauri-apps/cli | 2.11.4 | Apache-2.0 OR MIT |
| @vitejs/plugin-vue | 5.2.4 | MIT |
| jsdom | 30.1.0 | MIT |
| typescript | 5.6.3 | Apache-2.0 |
| vite | 6.4.3 | MIT |
| vitest | 5.0.1 | MIT |
| vue-tsc | 2.2.12 | MIT |

## 许可证全文

- MIT — <https://opensource.org/license/mit>
- Apache License 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>
