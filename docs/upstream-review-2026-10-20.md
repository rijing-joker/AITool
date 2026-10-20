# 四个上游更新评估 — 2026-10-20

基于 AiTool `dev` 的 `893e36a`，对照 GitHub 最新发布和默认分支，检查哪些更新尚未融入。以下为实施前的评估；第一批现已完成，代码范围、测试结果和核心截断检测限制见 [10 月 20 日集成记录](upstream-integration-2026-10-20.md)。

## 对比基线

| 上游 | AiTool 上次集中对齐 | 本次最新发布 | 本次默认分支快照 |
| --- | --- | --- | --- |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | v1.4.4 | [v1.4.7](https://github.com/xiufengsun/TokenTracker/releases/tag/v1.4.7) | `12f8a4793a` |
| [cc-switch](https://github.com/farion1231/cc-switch) | v4.0.14 | [v4.0.16](https://github.com/farion1231/cc-switch/releases/tag/v4.0.16) | `74cf8e6f0b` |
| [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) | v0.3.41；部分交互另对齐到 v0.3.44 | [v0.3.47](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.47) | `aee871a369` |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `core-version.txt` 为 v8.0.32 | [v8.0.35](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.35) | `3f0cef010e` |

集中对齐记录见 [10 月 17 日集成文档](upstream-integration-2026-10-17.md)。不能只按版本号判定缺口：本地 `893e36a` 已单独改进请求日志和隐私提示，部分早期上游功能也已移植。

## 第一批：稳定性与数据准确性

### 1. CLIProxyAPI 核心升级到 v8.0.35

**建议优先，主要通过升级外部核心获得。** v8.0.33–v8.0.35 的有效增量包括：

- 检测上游流式响应截断，改善异常结束的识别。
- 防止旧凭据快照覆盖新状态，避免不完整或原地文件写入导致凭据被误删。
- 改善 Codex OAuth 提前刷新和被拒令牌处理，以及 Antigravity 过期额度提示恢复。
- 保留跨 Responses / Claude / Gemini / Interactions 转换的推理签名，修复 OpenRouter 路由后缀传递。
- 清理 Gemini 不支持的 JSON Schema 字段，内联本地 schema 引用，并优化流式转换开销。
- 增加 Claude WebSearch 结果缓存和恢复；Kimi / Meta Responses 路由支持 Codex remote-compaction v2。

落点：`core-version.txt`、`scripts/fetch-core.cjs`、`src/lib/proxy/manager.js` 的升级兼容验证。沿用现有先下载、后停机、启动失败回滚的路径，核心继续作为独立进程。

验收应覆盖三种客户端协议的流式与非流式请求、工具调用、异常截断、RESP 用量桥接、ETag 条件写入和回滚；升级不能破坏已有桶连续性。

来源：[v8.0.33](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.33)、[v8.0.34](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.34)、[v8.0.35](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.35)。

**发布边界：** 默认分支另外有 [Claude 并行工具调用 / stop reason 修复](https://github.com/router-for-me/CLIProxyAPI/commit/c449529ecd) 和 [非流式 Responses reasoning_tokens 映射修复](https://github.com/router-for-me/CLIProxyAPI/commit/7db0935a63)。它们在 v8.0.35 之后，升级到该发布版不会获得这两项；可等下一版，或在明确需要时构建固定提交。

### 2. 修复队列缓存遗漏中间改写

**本地已复现，建议优先。** `src/lib/async-queue-reader.js` 当前在文件增长时只检查旧内容的开头和尾部各 256 字节。如果中间旧行被改写，同时文件追加新行，两端仍一致，就会沿用旧缓存。

合成队列验证：20 行中第 11 行的 `value` 从 100 改为 200，再追加一行，第二次读取仍返回 100。测试使用临时目录，没有触碰真实队列。

TokenTracker 已改为校验旧已提交前缀的摘要，并处理同大小、同文件时间戳的改写。可以移植到本地，但应保留共享 pending read、分块异步读取和不完整尾行处理；摘要校验会增加读取量，需检查大队列轮询成本。

来源：[TokenTracker v1.4.4 → v1.4.7 差异](https://github.com/xiufengsun/TokenTracker/compare/v1.4.4...v1.4.7)，`src/lib/async-queue-reader.js`。

### 3. ZCode 清理窗口之外的历史保留与恢复

**使用 ZCode 时优先，否则作为数据保护修复。** ZCode 原生用量表会清理约 30 天以前的记录。本地 `dropZcodeQueueRows` / `repairZcodeUsageMigration` 仍删除所有 ZCode 旧桶再重扫；如果旧记录已经不在数据库，历史无法靠重扫恢复。

上游新增重建范围判定，只清理仍可重建的窗口，并尝试从 `queue.jsonl.bak.*` 恢复窗口以前的历史。需要同时移植多安装目录的保守范围判断、未知覆盖范围时延后修复、游标和上传偏移一致性处理。

落点：`src/commands/sync.js`。不能直接复制上游整体重写队列的行为：AiTool 的 proxy bridge 会在 `sync.lock` 外追加同一队列，需要处理并发追加，避免修复时丢掉代理记录。

验收：保留 30 天以前的桶、窗口内正确重建、备份恢复不重复累计、连续 sync 两次保持一致，以及云上传仍受现有 opt-in 门控。

来源：[TokenTracker #830](https://github.com/xiufengsun/TokenTracker/pull/830)。

### 4. OpenCode `-free` 型号统一按来源保护为零价

本地已有多个免费型号的零价精确表，但没有 `source=opencode && model.endsWith('-free')` 的统一规则。新增或未列出的免费 ID 仍可能进入付费型号模糊匹配，也可能显示未定价。

合成验证：用本地 pricing seed 查询假设的 `gpt-4o-free`、来源 `opencode`，当前匹配到 GPT-4o 的付费价。这只证明匹配路径的风险，不表示 OpenCode 实际提供该型号。

建议按上游规则在通用匹配前短路，并保持规则仅对 OpenCode 来源生效。AiTool 的 OpenCode 免费代理适配器已有独立动态目录和零价验证，不应放宽其准入规则。

落点：`src/lib/pricing/matcher.js`，以及 5 份 analytics edge 文件中的同一规则。验证新免费 ID 为零价、其他来源不受影响和 edge pricing parity。

来源：[TokenTracker #839](https://github.com/xiufengsun/TokenTracker/pull/839)。

### 5. Codex GPT 自定义窗口与多层模型前缀

**两个缺口均已用合成模型目录复现。**

1. 本地 `buildCodexCatalog` 命中官方 GPT 模板后直接返回镜像，忽略用户填写的 `contextWindow`。构造官方窗口 272000、用户填写 400000，输出仍为 272000。cc-switch 已允许显式覆盖窗口，并同步 `max_context_window` 与压缩阈值；其后续修复仅限制借来的默认窗口，保留用户明确填写的值。
2. 本地只允许剥离一层简单命名空间。`team/vendor/gpt-5.5` 会落入通用模板，丢失官方 prompt、窗口和并行工具能力。EasyCLIProxyAPI 新增多层前缀的模板查找，保持对外路由 ID 原样。

落点：`src/lib/provider-switch/catalog.js` 和模型目录编辑界面。需要保留当前官方 harness prompt、服务档位、审批模型和用户覆盖的职责，并验证导入后再保存不丢窗口。前缀规则应按真实模型目录验证，避免过宽匹配把无关模型当成官方 GPT。

来源：[cc-switch #8385](https://github.com/farion1231/cc-switch/pull/8385)、[窗口限制后续修复](https://github.com/farion1231/cc-switch/commit/8d7a741540)、[EasyCLIProxyAPI 前缀能力修复](https://github.com/router-for-me/EasyCLIProxyAPI/commit/f4351b93e9)。

### 6. Codex 压缩归档补齐 `.jsonl.zstd`

本地已经支持 `.jsonl.zst`，因此不是重新实现压缩读取。剩余缺口是 `src/lib/codex-rollout-file.js` 只识别 `.zst`：合成文件名 `.jsonl.zstd` 的 `isRollout` 为 false，线程 ID 解析为 null。

补齐识别、逻辑路径、相邻文件去重、会话分组、sync、context breakdown 和 transcript reader；保留本地现有快照限制、根目录校验和分页 / fork replay 计费保护。

来源：[TokenTracker #829](https://github.com/xiufengsun/TokenTracker/pull/829)。

## 第二批：运维体验与额度可见性

### 7. 代理核心异常退出自动恢复

EasyCLIProxyAPI 新增了有预算的后台恢复。本地 `serve` 只在启动时 auto-start，`manager.status()` 只报告状态，没有同等恢复机制。

建议移植恢复策略：只接管已成功启动或确认身份的核心；2 / 5 / 15 秒退避；滚动 5 分钟最多 3 次，成功启动也不清空预算；手动停止、升级或退出取消旧任务；耗尽后显示失败并等待手动操作。不能因为端口探测超时而杀掉仍存活的核心。

落点：Node 核心管理层与 `serve` 生命周期，恢复后连接 usage bridge，并恢复已启用的 OpenCode 适配器。继续使用本地已实现的进程身份检查和累计桶持久化。

来源：[EasyCLIProxyAPI core-recovery.md](https://github.com/router-for-me/EasyCLIProxyAPI/blob/aee871a369ad3494c213806da8f8ba8c840e79b8/docs/core-recovery.md)。

### 8. Grok 周额度池的各产品占比

TokenTracker 现在展示 Grok Build / Bot / Chat / Imagine / Cursor 占同一额度池的份额。本地解析了总池 `productUsage`，但没有返回逐产品展示数据。

落点：`src/lib/grok-limits.js`、`src/lib/usage-limits.js`、dashboard provider specs / 用量卡片，以及需要保留的原生展示。产品行不能再次加到总用量，也不能作为独立 100% 额度计算剩余值或耗尽 ETA。

来源：[TokenTracker #835](https://github.com/xiufengsun/TokenTracker/pull/835)。

### 9. Windows 手动启动与 Node / VS Code 识别

- **手动启动唤起 dashboard：** 本地 Windows 程序第二次普通启动直接退出，没有向现有实例发送激活事件。可移植 TokenTracker 的 activation 消息和提前启动监听器，同时保持登录自启动的安静行为。来源：[TokenTracker #832](https://github.com/xiufengsun/TokenTracker/pull/832)。
- **fnm 安装的 Node CLI：** 本地 Windows 全局二进制兜底目录只有 `%APPDATA%/npm`，可借鉴 cc-switch 对 fnm 默认安装路径的补充，保持现有 PATH 优先。来源：[cc-switch fnm 修复](https://github.com/farion1231/cc-switch/commit/3b1f11b6f1)。
- **VS Code 版本读取：** 本地 Copilot 状态读取已经只读配置，不会启动编辑器；但是连接前的 `executable()` 仍调用 `--version`。可借鉴 EasyCLIProxyAPI 的 product.json / package.json 识别，改善未知包装器和桌面二进制兼容性。不要把显式连接时的原生 secret handoff 与状态检测混为一谈。来源：[EasyCLIProxyAPI 被动检测](https://github.com/router-for-me/EasyCLIProxyAPI/commit/5126dda197)。

### 10. 可按使用需求补充的功能

- **Codex remote compaction 开关：** 配合新版核心有价值，但涉及 provider 身份和历史会话可见性，应作为独立实验项，默认关闭，保留备份与切回路径。来源：[EasyCLIProxyAPI v0.3.45](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.45)。
- **智谱账户余额 / 火山套餐查询：** cc-switch 的最新修复可作为扩展本地 `quota.js` 的参考。当前本地没有对应的查询适配器，属于新增支持；火山需要 AccessKey ID / SecretAccessKey，不能把推理 API Key 当成查询凭据。来源：[cc-switch v4.0.16](https://github.com/farion1231/cc-switch/releases/tag/v4.0.16)。
- **托盘快捷供应商切换：** cc-switch 的快捷面板很适合高频切换，但 AiTool 有多套桌面壳，需要选择要维护的壳后再做。优先复用供应商、代理状态和额度 API，沿用 AiTool 的现有设计语言。最新跨屏 DPI 修复在 v4.0.16 之后，不能只搬发布版面板而忽略后续修复。
- **MiniMax-M3.1-Flash 等预设和模型价格：** 可按实际使用补充；价格要核对官方数据，并保留 analytics 与 models.dev 两套价格系统的边界，不宜直接用 cc-switch 的价格表覆盖本地规则。

## 已有能力与暂缓项

- 已有：Codex 自动审批模型、速度档位保留、daemon 重启提示、Copilot 全模型目录、Antigravity 命名额度窗口、WorkBuddy 项目归属、Muse 只读统计、核心分阶段升级与回滚、请求日志列管理和隐私提示。本次不重复列为新增。
- 官方 Codex 卡片的 editor 已通过本地 `projectCodex` 显示切换后的 auth，现有保存路径也不直接存整份 OAuth token；cc-switch 的旧快照问题不能仅凭发布说明判定本地同样存在。
- 暂缓：EasyCLIProxyAPI 原生插件商店、插件 WebView、系统玻璃材质和全套自定义主题；cc-switch 自己的 Rust 代理路由与聚合引擎。这些需要新增长期维护边界，收益小于先完成稳定性与数据修复。
- cc-switch 的协议转换修复应作为 CLIProxyAPI 的兼容用例来源；AiTool 不宜为了这些修复再引入第二套请求转换引擎。

## 建议实施顺序与验证范围

先做 **核心升级 + 队列缓存 / ZCode 历史 / OpenCode 零价**，再做 **Codex 窗口 / 前缀 / `.zstd`**，接着是 **异常恢复 + Grok 额度分项**。Windows 体验和新增套餐支持按使用需求跟进；remote compaction 和托盘面板独立排期。

评估阶段检查了本地源码、上游发布说明和提交差异，并运行合成输入验证窗口覆盖、前缀继承、压缩文件识别、队列缓存改写和免费后缀匹配。该阶段没有运行完整测试套件或实测新版核心；后续已完成的实现和验证单独记录在集成文档中。真实账户额度和 Windows 图形行为尚未实测。

遵循 `CLAUDE.md` 的个人 fork 规则：实施时作为普通开发提交，不发版、不 bump 应用版本、不发布 npm；核心版本 pin 的升级另按现有机制处理。
