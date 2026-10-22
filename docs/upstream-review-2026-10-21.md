# 四个上游更新评估 — 2026-10-21

对照 AiTool `dev` 的 `2bc4751`、10 月 20 日首批集成，以及当前未提交的 CLI 会话阅读器改进。GitHub 发布与默认分支于 **2026-10-21 晚间（北京时间）**核对；这是候选更新评估，没有实施以下集成。

## 本次基线

| 上游 | 最新正式发布 | 本次默认分支固定快照 | AiTool 状态 |
| --- | --- | --- | --- |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | [v1.4.7](https://github.com/xiufengsun/TokenTracker/releases/tag/v1.4.7) | `4cb82c706648` | 10 月 20 日的数据保护、免费定价及压缩归档已集成；发布后的本地 Key 存储和 Sentry 尚未移植。 |
| [cc-switch](https://github.com/farion1231/cc-switch) | [v4.0.17](https://github.com/farion1231/cc-switch/releases/tag/v4.0.17) | `0a41250dc03a` | 已有 provider/MCP/prompts 移植；阅读器改进在工作区。新增的压缩用量格式、Hermes 标识提醒和 agy 管理仍有缺口。 |
| [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) | [v0.3.50](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.50) | `9fc0a33b6528` | 凭证页仍是早期交互移植；本次新增的批量刷新、请求策略和插件额度未引入。 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | [v8.0.37](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.37) | `ce07d189b3de` | 仓库 pin 和本机安装版本文件均为 v8.0.35；未替换或重启真实核心。 |

发布和主分支要分开：TokenTracker 的 Key 存储在 v1.4.7 之后；cc-switch 的 agy 与官方多账号管理在 v4.0.17 之后。它们适合移植，但不能说升级到上述发布版就会获得。

此前完成的内容见 [10 月 20 日集成记录](upstream-integration-2026-10-20.md)，会话阅读器工作区状态见 [10 月 21 日会话对照与实施记录](cli-sessions-cc-switch-review-2026-10-21.md)。

## 优先引入

### 1. CLIProxyAPI v8.0.35 → v8.0.37

**优先级高；以升级外部核心和兼容验证为主。**

v8.0.36 包含上次评估尚未发布的 Claude 并行工具调用/stop reason、非流式 Responses reasoning_tokens 修复，并新增：

- Claude refusal、context window、pause_turn 结束原因映射和 `parallel_tool_calls` 处理。
- SGLang 等 OpenAI-compatible 上游的平铺 `reasoning_tokens` 识别、有效 token 帧的 TTFT 计算。
- 认证文件完整扫描遇到读取错误时保留凭证，SIWC 绑定/上传互斥与账户替换保护。
- Claude WebSearch 结果缓存按上游凭证分隔，减少切换账户时串用同会话缓存的可能。
- Gemini 思考签名跨 OpenAI Chat 转换保留，以及 Antigravity Hub 指纹/模型缓存对齐。

v8.0.37 继续增加 Gemini 终止流取消后的用量保留、Claude 空文本块清理、多种流式工具名转换的性能优化，以及 Vertex 按模型/凭证选择 OpenAPI 路由、只读 SIWC 状态。

落点：`core-version.txt`、`scripts/fetch-core.cjs`、`src/lib/proxy/manager.js`，复用 `scripts/acceptance/proxy-core-smoke.cjs`。现有安装器已经会查在线最新版本，pin 是基线/回退，并非硬性锁死版本。

验收应保留四种客户端协议、流式/非流式工具往返、用量桥重连累计、ETag 冲突、下载与启动失败回滚。还需重新测 clean EOF：**不能仅凭更新说明认定 v8.0.35 的 Chat/Gemini 截断成功状态缺口已修复**。本次没有运行 v8.0.37 二进制。

Linux 发布另提供 `_no-plugin` 便携包；AiTool 目前按平台选择默认包。支持 Alpine/OpenWrt 时再补 musl 包选择，当前 Debian 容器无需为此改下载策略。

来源：[v8.0.36](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.36)、[v8.0.37](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.37)、[两版总差异](https://github.com/router-for-me/CLIProxyAPI/compare/v8.0.35...v8.0.37)。

### 2. Codex 远程压缩的另一种用量日志格式

**已复现漏计，建议与核心升级同批处理。** cc-switch [#8479](https://github.com/farion1231/cc-switch/pull/8479) 处理的是 `token_usage_record` 后跟 `last_token_usage` 全零的 `token_count`，记录中的 `usage` 才是这次压缩调用的用量。

AiTool 并非完全没有处理 `token_usage_record`：`src/lib/codex-usage-record.js` 已支持「此前出现过 token_count → usage record → 紧邻 compacted → 下次累计值不变」。新上游规则涵盖不带 `compacted`、首个请求就是这种记录的情形；本地的条件会漏掉它们。

临时合成 JSONL 验证结果（输入 26,705、输出 491）：

| 场景 | 应计 total tokens | 本地 session analytics 解析器 | 本地 analytics 队列 |
| --- | ---: | ---: | ---: |
| 首次记录为 usage record，随后全零 token_count | 27,196 | 0 | 0 |
| 已有一条 1,050-token 正常请求，再出现同类压缩记录 | 28,246 | 1,050 | 1,050 |

上述只验证格式兼容性，不证明真实用户历史里已经存在这些记录。`src/lib/sessions.js` 的 transcript cost 读取还只处理 token_count，未复用压缩记录状态机，应该一起对齐，避免不同页面估算不一致。

落点：`codex-usage-record.js`、`rollout.js`、`codex-rollout-parser.js`、`sessions.js`。保留正常 record/token_count 不重复计费、response_id 去重、分页/fork replay、未完整尾行及事务游标；不要直接累加每条 usage record，也不能从 `thread_token_usage` 再算一次费用。历史修复需要独立制定范围和重扫策略。

### 3. Hermes 自定义供应商标识冲突提醒与预设修正

**优先级高，范围较小。** cc-switch v4.0.17 新增提醒：新版 Hermes 遇到 `deepseek`、`nous`、`openrouter` 等规范内置 ID，会走内置供应商，而忽略同名 custom provider 的地址/Key。

AiTool 的 Hermes DeepSeek 和 Nous 预设当前分别使用 `slotKey/name = deepseek/nous`；合成投影也确认 `model.provider` 被写成 `deepseek`。本地没有冲突提醒，属于明确的配置风险；实际覆盖哪些 ID 仍取决于安装的 Hermes 版本，本次没有运行 Hermes。

建议新预设使用 `aitool-deepseek`、`aitool-nous` 等独立 ID，创建/编辑时提示规范内置 ID 冲突；已有卡片提供显式迁移或重建路径，保持用户修改和备份。不要批量改写已有自定义 ID，别名如 `kimi` 也不能一概视为冲突。

落点：`src/lib/provider-switch/presets.js`、`additive.js`、`dashboard/src/pages/provider-edit-dialog.jsx`。

来源：[提醒实现](https://github.com/farion1231/cc-switch/commit/f460410f5d0f)、[固定版本 ID 表与适用说明](https://github.com/farion1231/cc-switch/blob/0a41250dc03a01dd6418ed815023fd46db9b7840/src/config/hermesBuiltinProviderIds.ts)。

### 4. 凭证手动刷新、批量管理和单凭证请求策略

**高价值，主要改善多账号/代理日常维护。** EasyCLIProxyAPI v0.3.50 新增：

- 单个 OAuth 凭证刷新；批量刷新/启用/停用/删除，显示逐项结果；服务端全部刷新不受当前筛选限制。
- 「存在问题」筛选，搜索覆盖备注和模型前缀。
- 单凭证重试次数、错误处理规则，支持恢复继承全局。
- xAI 官方 API/Grok CLI chat-proxy 模式选择。

AiTool 已有启停、删除、冷却重置、配置弹窗，但未提供上述批量刷新/请求策略。`proxyApi.refreshAuthFiles` 是现有旧路由封装，页面没有调用；实际新的刷新接口是 `/v8/management/credentials/refresh`。现有启停请求只带 name，可补 `auth_index` 解决同名歧义。

落点：`auth-files-tab.jsx`、`easy-auth.ts`、`proxy-api.ts`、`src/lib/proxy/api.js`。现有通用管理转发会把超时限制在 120 秒，上游刷新使用 300 秒；应给这种长任务单独的受限路径或任务状态，不能只改前端超时。单凭证刷新响应可能包含 token，Node 端应只返回必要的确认/结果字段。

批量操作沿用顺序执行、逐项失败可见、本地写认证与删除确认。刷新认证不等于重置额度。

来源：[v0.3.50](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.50)、[刷新与批处理实现](https://github.com/router-for-me/EasyCLIProxyAPI/blob/9fc0a33b65284e887c8536fa4ea166ffa33a0367/src/services/authFileOperations.ts)、[核心 v8 路由](https://github.com/router-for-me/CLIProxyAPI/blob/ce07d189b3de2a39d37fd68ae093b102ce3aabee/docs/management-api-v8.md)。

### 5. 额度页直接保存 OpenCode Go / Command Code API Key

**建议引入，尤其适合当前 Linux 使用场景。** TokenTracker [#842](https://github.com/xiufengsun/TokenTracker/pull/842) 把 Key 保存在应用数据目录的 0600 文件，环境变量仍优先，换 Key 会使正在进行的额度查询与缓存失效。

AiTool 的 OpenCode Go 设置提示仍让用户复制 `launchctl setenv`，不适用于 Linux/Windows；目前 Go Key 只从环境读取，Command Code 从环境或自己的 CLI auth 文件读取。已有 provider-switch 卡片 Key 并不等同于额度页的账号设置。

落点：新增局部 Key store、`local-api.js`、`opencode-go-limits.js`、`commandcode-limits.js`、`usage-limits.js` 和 `UsageLimitsPanel.jsx`。保留环境优先、CLI 登录回退、Key 只留本地，UI 展示来源/是否配置而不返回原文；并确保旧 Key 发出的查询完成后不会污染新 Key 的结果。

### 6. 核心异常退出的有限自动恢复

**上次剩余项仍然值得做。** EasyCLIProxyAPI 已有 2/5/15 秒退避、滚动五分钟最多三次的恢复；成功重启不清空预算，手动停止/升级/退出会取消旧任务。

AiTool `manager.js` 仍无对应恢复状态机。可复用现有进程身份验证和生命周期操作，在 `serve` 存活期间恢复自己成功启动的核心、usage bridge 及已启用的 OpenCode adapter。管理端口暂时不可达不能作为杀进程的依据。

落点：`src/lib/proxy/manager.js`、`src/commands/serve.js` 与状态展示。应使用现有状态消费者或明确的服务端观察路径；桌面隐藏后不能因为 UI 停止轮询而失去故障检测。

旧 `docs/core-recovery.md` 已在上游后续提交删除，但当前默认分支仍有实现；引用当前源码更可靠：[core_recovery.rs](https://github.com/router-for-me/EasyCLIProxyAPI/blob/9fc0a33b65284e887c8536fa4ea166ffa33a0367/src-tauri/src/core_recovery.rs)。

### 7. 原生窗口隐藏时同步暂停界面轮询和倒计时

**部分已有，补原生边界即可。** AiTool 已有 `useVisiblePolling` 与 document visibility 检查，不能说尚未实现所有隐藏暂停。EasyCLIProxyAPI v0.3.48–49 解决的是原生窗口隐藏/最小化后 WebView 仍活跃的情况，并同步暂停倒计时和界面事件。

本地多套桌面壳尚无统一窗口可见事件；Windows 还主动关闭过后台节流。建议增加原生 visible/minimized → dashboard 信号，恢复可见时立即刷新；仅失去焦点不能暂停第二显示器上的可见窗口。核心、用量桥和本地采集继续运行。

Linux 主窗口在本地已经按默认不透明方式创建，不需照搬上游的透明窗口修复，更不能因此取消桌面宠物窗口的透明背景。

来源：[v0.3.49](https://github.com/router-for-me/EasyCLIProxyAPI/releases/tag/v0.3.49)、[窗口活动实现](https://github.com/router-for-me/EasyCLIProxyAPI/blob/9fc0a33b65284e887c8536fa4ea166ffa33a0367/src-tauri/src/window_activity.rs)。

## 下一批功能

| 候选 | 收益与当前缺口 | 引入边界 |
| --- | --- | --- |
| **Antigravity CLI（agy）独立管理** | cc-switch 发布后的最大功能增量：供应商/模型、MCP、Skills、会话，后续又加官方账户绑定与逐账号额度。AiTool 已有 Antigravity analytics/额度，不等于已有这些管理入口。 | 独立 app ID 和配置路径；先做 provider/MCP/prompts 与只读会话，再做账户绑定。API Key 启动有独立目录/终端生命周期，不能直接套 Gemini 全局 .env 投影。来源：[agy 固定版本指南](https://github.com/farion1231/cc-switch/blob/0a41250dc03a01dd6418ed815023fd46db9b7840/docs/agy-integration-zh.md)、[账号配额查询](https://github.com/farion1231/cc-switch/commit/5a08e230c01e)。 |
| **Grok 共享周额度按产品展示** | TokenTracker 已显示 Build/Bot/Chat/Imagine/Cursor 各自占总池比例；AiTool 当前只汇总 `productUsage`，未返回逐产品数据。 | 产品行是共享池的已用份额，不是独立额度，不再加到总量，也不切成“本产品剩余 100%”。来源：[#835](https://github.com/xiufengsun/TokenTracker/pull/835)。 |
| **插件凭证额度查询** | Easy v0.3.50 统一凭证页/额度页支持判定、窗口/余额展示、并发查询和旧核心路由回退；AiTool 目前未有对应能力。 | 可以接核心已加载插件的 quota API，不必先引入插件商店；原生供应商查询优先。Gemini OAuth 登录本身不代表可查额度。 |
| **Windows 手动启动唤起已有窗口、fnm 识别** | 第二次启动本地 Windows app 仍仅转发 OAuth 深链；Windows npm 路径兜底未覆盖 fnm 安装目录。 | 手动启动发 activation，自启动安静；fnm 只补兜底，保持 PATH 优先。来源：TokenTracker [#832](https://github.com/xiufengsun/TokenTracker/pull/832)、cc-switch [fnm 修复](https://github.com/farion1231/cc-switch/commit/3b1f11b6f1)。 |
| **API Key 输入禁用自动大写/纠错** | cc-switch v4.0.17 修了 macOS 明文 Key 自动大写；AiTool SecretInput 只有 autocomplete/spellcheck 设置，没有 autoCapitalize/autoCorrect。 | 属于低成本输入保护，可随凭证界面一起补；本次未在 macOS 复现。 |
| **更多 transcript 来源** | 会话工作区已补工具摘要、diff、缓存/长正文，仍仅 Claude/Codex/Gemini。 | 可借 cc-switch 扩展 OpenCode、Hermes、Grok Build、Pi、MiniMax、agy；优先实际使用的来源，保持只读、根目录校验。 |

remote compaction 的配置开关、智谱余额/火山套餐查询、托盘供应商快捷面板仍是此前的可选项。火山查询需要独立控制面凭据；托盘面板需选择维护哪套壳，再保留 DPI 和 WebView 释放修复。本地已经查询 DeepSeek/StepFun/SiliconFlow/OpenRouter/Novita 余额，不能笼统推荐“新增供应商余额功能”。

## 不需要重复移植或暂缓

- **已完成：** 队列摘要校验、ZCode 窗口历史保护、OpenCode `-free` 来源零价、Codex `.zstd`、显式模型窗口/多层前缀，以及当前工作区的工具结果/diff/长正文阅读器改进。
- **MCP URL-only 和并发写入：** 本地 `specTransportType` 已识别 url-only，live file 写入已有 `withFileLock`，还有多 app 并发回归。新上游发布说明不能证明这里再次需要同样修复。
- **过期 Codex stash 自动还回第三方代理：** cc-switch 的修复专门限制 `ProxyThirdParty { restore_last: true }`。AiTool 第三方路径会 stash 登录而不自动还回，官方切回才恢复，因此没有复现相同触发路径。未来增加“代理下保留/恢复官方登录”时再移植过期检查。
- **TOML 弯引号：** cc-switch 修的是其已有全局引号替换；本地没有对应归一化步骤，合法字符串不会因此被重写。可另加输入法定界符兼容，但不是当前已证实 bug。
- **DeepSeek V4.1 Flash 定价：** 本地已有精确项与先于 V4 Flash 的模糊项，无需重复搬 cc-switch 的本次价格修复。
- **Sentry：** TokenTracker [#841](https://github.com/xiufengsun/TokenTracker/pull/841) 是可选远程错误上报；私人 fork 暂缓。确有远程诊断需求时再做明确 opt-in 与字段脱敏，不照搬上游云项目/DSN。
- **赞助预设、MSI 更新/便携标记、WebDAV 胶囊、第二套 Rust 代理：** 前者收益低或本地没有对应模块，后者会新增请求转换引擎维护边界，不建议本次引入。插件商店和整套主题也不优先。

## 推荐批次与验证

1. **正确性与兼容：** v8.0.37 升级验证、Codex 新压缩格式、Hermes ID 提醒/新预设、Key 输入保护。
2. **代理维护体验：** 凭证刷新/批量操作/请求策略、有限自动恢复、原生窗口隐藏暂停。
3. **额度与扩展：** Key 本地保存、Grok 产品占比，再按实际使用引入 agy 和插件额度。

本次读取本地源码、GitHub release/compare/固定提交，运行了临时合成 Codex 日志和 Hermes 投影；没有新增生产测试。已有相关回归 **21 项通过，0 失败**：

```bash
node --test --test-name-pattern='mcp: concurrent|url-only|compaction: session parser|compaction: a token_count|compaction: repeated sync' test/provider-switch-mcp.test.js test/codex-token-usage-record.test.js
```

这些通过的用例验证已有格式与 MCP 保护；上述新的 Codex 格式通过独立合成输入证实漏计，不被这些用例覆盖。没有运行全量 CI、v8.0.37 真实核心、Hermes/agy 原生程序或真实账号额度。此次只新增评估文档，没有修改业务代码、用户会话/配置、安装版本或发布状态。
