# 文档索引

当前使用与实现说明按 2026-10-23 的工作区代码核对。项目规则只维护在 [CLAUDE.md](../CLAUDE.md)，[AGENTS.md](../AGENTS.md) 保持入口指针。

## 入门与项目全貌

| 文档 | 内容 |
| --- | --- |
| [README](../README.md) / [简体中文](../README.zh-CN.md) | 产品功能、快速启动与入口 |
| [architecture.md](architecture.md) | 技术栈、数据流、45/10/9 支持边界、代码/API/存储定位 |
| [running.md](running.md) | CLI、开发服务器、桌面壳、平台应用、Docker 与排错 |
| [PRODUCT.md](../PRODUCT.md) / [DESIGN.md](../DESIGN.md) | 产品原则、设计 token、主题与组件约定 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 本地验证、修改入口和个人 fork 工作流 |
| [PRIVACY.md](PRIVACY.md) / [SECURITY.md](../SECURITY.md) | 统计与正文边界、凭据、网络行为与本地信任模型 |
| [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | 代码与资源归属；许可证随各适配模块保留 |

## 当前模块指南

| 文档 | 内容 |
| --- | --- |
| [magpie-integration.md](magpie-integration.md) | MCP 检查/envref/过滤、诊断、组合方案、分发、WorkBuddy/Zed、订阅适配、工具/路由 |
| [copilot-proxy.md](copilot-proxy.md) | Copilot CLI / VS Code 连接、模型选择和恢复 |
| [opencode-free-integration.md](opencode-free-integration.md) | 可选免费模型目录、独立 adapter、生命周期及限制 |
| [openclaw-integration.md](openclaw-integration.md) | OpenClaw 统计接入与兼容处理 |
| [opencode-go-limits.md](opencode-go-limits.md) | 官方 Go 用量 API 与显式本地估计 |
| [devin-limits.md](devin-limits.md) / [devin-usage.md](devin-usage.md) | Devin 配额读取和用量解析 |
| [qoder-cn-limits.md](qoder-cn-limits.md) | Qoder CN CLI 订阅、额度与 add-on credits |
| [antigravity-limits.md](antigravity-limits.md) | Antigravity 限额来源与保守处理 |
| [trae.md](trae.md) | TRAE 本地数据库、授权读取与路径覆盖 |
| [zcode-history-correction.md](zcode-history-correction.md) | ZCode 保守历史修复与队列连续性 |
| [quality-per-dollar.md](quality-per-dollar.md) | 会话效率/价格指标的定义与限制 |

## 平台与开发资源

- [AiTool desktop 壳](../desktop/README.md)：依赖本地 checkout 和 Node，macOS app/dmg 配置。
- [Windows 客户端](../TokenTrackerWin/README.md)、[Linux 客户端](../TokenTrackerLinux/README.md)、[GNOME 扩展](../TokenTrackerLinux/gnome-extension/tokentracker@tokentracker.cc/README.md)。macOS 定义为 `TokenTrackerBar/project.yml`，运行/打包入口见 [running.md](running.md)。
- [UI Foundation](../dashboard/src/ui/foundation/README.md)、[Bot 引擎](../dashboard/src/lib/bot/README.md)、[成就资源](../dashboard/public/achievements/README.md)。
- [代码图索引](../scripts/graph/README.md)。

## 实施、研究与审查记录

以下文档保存当时的上游提交、候选方案、实施顺序、测试次数和验证边界，不是当前功能的总清单；已实施状态优先看源码与模块指南。历史测试结果不随文档更新改写。

| 记录 | 用途 |
| --- | --- |
| [Magpie 调研](magpie-integration-research.md)、[实施计划](magpie-implementation-plan.md) | 固定上游快照、选型、实施与原始验证依据 |
| [WorkBuddy 代理调研](workbuddy-proxy-research.md) | 协议、身份/usage 语义与适配验证 |
| [2026-10-21 上游实施](upstream-integration-2026-10-21.md)、[候选审阅](upstream-review-2026-10-21.md) | agy、多来源正文、配额、恢复和桌面增量 |
| [2026-10-20 上游实施](upstream-integration-2026-10-20.md)、[候选审阅](upstream-review-2026-10-20.md) | 当日上游吸收范围 |
| [2026-10-17 上游实施](upstream-integration-2026-10-17.md)、[2026-10 上游实施](upstream-integration-2026-10.md) | 更早迁移与兼容记录 |
| [CLI Sessions / cc-switch 对照](cli-sessions-cc-switch-review-2026-10-21.md) | 阅读器语义和呈现对照 |
| [2026-10-01 Bug 审查](bug-audit-2026-10-01.md) | 历史审查与平台验证边界 |
| [设备用量拆分设计](superpowers/specs/2026-06-24-per-device-usage-breakdown-design.md) | 历史设计规格 |
