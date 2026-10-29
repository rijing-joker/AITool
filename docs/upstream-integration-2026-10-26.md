# 五上游更新实施 — 2026-10-26

对照 [upstream-review-2026-10-26.md](upstream-review-2026-10-26.md) 实施。基线 `dev` = `53783df82`。本轮未提交、未发布、未部署 edge functions；Swift 菜单栏的 WorkBuddy 行按评审建议后置。

## 实施结果

### 1. CLIProxyAPI 核心 pin v8.0.43（P0）

`core-version.txt` 由 `v8.0.41` 升到 `v8.0.43`，用 `AITOOL_CORE_FORCE=1 node scripts/fetch-core.cjs` 重新拉取并安装。管理端点、RESP usage 载荷、config/auth 格式与 ETag 语义按评审结论零改动，Node 侧没有配套修改。隔离 smoke 通过：RESP normalized usage 重启连续性、管理面 ETag 往返与 stale revision 拒绝。

### 2. 定价修复四件套（P1）

- `src/lib/pricing/matcher.js`
  - `-free` 后缀判断移到 curated/LiteLLM exact 之后、alias/fuzzy 之前，跨源 `*-free` 一律 $0；curated 显式 free 条目不再被早退遮蔽。
  - kimi-k2.8 / kimicoding / k2.8 加 miss-guard，不再经 fuzzy `kimi → kimi-k2.5` 误计价。
  - qwen3.8-max 三条 exact + 国际价 regex，并按 AiTool 既有顺序保留 qwen flash regex 在 curated exact 之后。
  - `lookupContainedExactCaseInsensitive` 阻断 `preview`/`next`/`exp`/`experimental`/`beta`/`alpha` 等替代 SKU 后缀。
- `src/lib/pricing/curated-overrides.json`：新增 kimi-k3.1-pro/highspeed 与紧凑别名、qwen3.8-max 三档、muse-spark-1.2-contributor-free，并排在 kimi-k3 fuzzy 之前。
- 五份 `dashboard/edge-patches/tokentracker-*.ts` 的 `MODEL_PRICING`/`getModelPricing` 逐字同步；`test/edge-pricing-parity.test.js` 保持字节一致。
- 回归：`test/pricing.test.js` 96 项、`test/edge-pricing-parity.test.js` 23 项通过。
- **未做**：edge functions 部署（共享外部动作，需单独执行）。

### 3. Claude 会话标题/摘要跳过本地命令输出（P1）

`src/lib/sessions.js` 新增 `isInjectedClaudeText`：`<local-command-caveat>`、`<local-command-stdout>`、`<local-command-stderr>`、`<task-notification>` 不再进入 Claude 会话标题或摘要；`<command-name>` 仍跳过。`test/cli-sessions.test.js` 增加对应用例。

### 4. OMP 会话面（P1）

- `src/lib/omp-session.js`：从 TokenTracker `9cbe2fd5` 近原样移植，仅存元数据。
- `src/lib/session-analytics.js`：`SIDECAR_VERSION = 29`；OMP 文件发现、签名、保留、清理与 `omp --resume` 恢复命令接线。OMP home 解析区分真实 HOME 与测试隔离 HOME（`OMP_HOME`）。
- Sessions 页：`sessions-api.ts`/`sessions-insights.js`/`SessionsPage.jsx` 增加 `omp` 来源与筛选；`test/session-analytics-omp.test.js` 14 项通过。
- CLI 会话第 8 个只读来源：`session-sources.js` 的 `omp` roots（`PI_CODING_AGENT_SESSION_DIR`、`OMP_HOME`/`PI_CONFIG_DIR`、profiles）复用 Pi 树解析，支持 title slot、header title 与 `OMP_PROFILE`/`PI_PROFILE` 恢复命令；`test/upstream-session-sources.test.js` 19 项通过。
- OMP provider-switch（第 12 个受管应用）未纳入本轮，见下文。

### 5. WorkBuddy 订阅额度（P1）

- `src/lib/workbuddy-ipc.js`、`src/lib/workbuddy-limits.js`：移植 wbipc endpoint 发现、HMAC ticket、unix socket/命名管道 JSON-RPC，以及 CN/国际两版 billing 汇总；只保留订阅套餐行，不把奖励/额外积分并入。
- `src/lib/usage-limits.js`：`workbuddy`/`workbuddyAi` 并行读取，`selectWorkbuddyLimits` 合成单行；可用者优先、CN 决定性胜出、永不加总。
- Dashboard：`limits-providers.js`、`usage-limits-provider-specs.js`、`UsageLimitsPanel.jsx` 增加 WorkBuddy 行与 `showCreditDetail`；landing 计数 17→18。
- 测试：`test/workbuddy-ipc.test.js` + `test/workbuddy-limits.test.js` 24 项通过；`test/discovery-metadata.test.js` 更新。
- **后置**：Swift 菜单栏的 WorkBuddy 行。`test/limits-providers-parity.test.js` 用显式 `SWIFT_MENUBAR_DEFERRED` 记录该例外，dashboard 先上线。

### 6. WorkBuddy Claude 模型 Messages 端点旁路（P1）

`src/lib/proxy/extensions/workbuddy.js`：Claude 系模型优先 POST `/v1/messages`（`anthropic-version`），把 OpenAI chat 请求转换为 Anthropic Messages（system 聚合、tool_use/tool_result、`tools.input_schema`、`output_config.effort`、`thinking: adaptive`），响应/流再转回 OpenAI；任何协议或上游失败回退到原有 `/v2/chat/completions`。401 续期后重新走同一选择；WorkBuddy AI（非 Claude）保持 chat。

`test/proxy-magpie-integration.test.js` 新增合成 SSE 用例：effort/thinking 透传、chat 回退、WorkBuddy AI 不旁路。**未做真实账号实测**：本机未安装 WorkBuddy 桌面端，旁路按社区插件 0.1.32 的证据实现，失败时始终回退，不会比现状更差。

### 7. P2 小项

| 项 | 结果 |
| --- | --- |
| Kimi 无订阅显示 | `provider-kimi-accounts.jsx` 在 `credentialStatus === "valid"` 且无 tiers 时显示“未订阅”；copy 六语言。 |
| DeepSeek 余额语义 | `quota.js` 不再把 `is_available:false` 当 key 失效；负余额/0 仍有效，前端红字金额；`-0` 归一为 `0`。 |
| Kimi 官方卡模型编辑 | 新增 `kimi.updateOauthModels`、账号 manager `models`/`updateModels`，以及 `GET/PUT /kimi/accounts/models`；用账号自己的 token 刷 `/models`，保存时只接受模型 key，连接与凭据保持不变；拒绝删除当前默认模型或仍被 secondary_model 引用的模型。 |
| Kimi “从 Kimi 移除” | 新增 `kimi.restoreOauthAccount`、manager `removeFromKimi`/`restore`，`POST /kimi/accounts/detach|restore`；节点、模型和服务引用移出 config.toml，但卡片、凭据和 connection 快照留在本地 store，可加回。已移出的卡片还可直接“重新登录”：登录流程读取快照连接，成功后自动加回并清掉快照。仍存活的独立账号必须先移出才能删除；Kimi 默认登录仍只隐藏、不登出。UI 增加 Edit / Remove from Kimi / Add back 与已移出徽标。 |
| Pi/omp `$NAME` 出站解析 | `provider-switch/api.js` 的 `resolvePiApiKey`：支持 `$NAME`/`${NAME}`/`$$`/`$!`，未设置或空值按空串发送，`!command` 永不执行；仅用于模型抓取。 |
| Grok 分段池条 | **未实施**：AiTool 当前为文本 product_shares 行，两个正确性修复针对的分段 UI bug 不存在；升级需一次取 TokenTracker 五提交最终态并决策 Cursor Sand 去重，属产品决策，留待单独立项。 |
| 展开组焦点环 | `UsageLimitsPanel.jsx` 非 header `ToolGroup` 增加 `focus-visible:ring-2 ring-oai-brand-500`。 |
| WorkBuddy 自写 models.json 误报 | `proxy/desktop-clients.js` 的投影比较忽略 `apiKey`（WorkBuddy 会写 WBEF1 加密值），与既有 disabled/reasoning 同等处理；新增回归测试。 |
| Magpie 检查项 | `c8901d4`（auto 分类器未知档位 no reasoning）、`ef1a203`（agy 429 按 reset 播眠）、`a60493a`（Codex-in-Claude-Code 归属）均属 Magpie gateway 的本地分类器/账号路由/归属层；AiTool 无等价模块（usage 来源为 CLIProxyAPI 与本地会话解析），无代码可移植。 |
| agy 子代理模型恢复 | 现有 field 19 join 与 `dbReadOk=false` 下轮重试逻辑正确；新增回归：库缺失时先按 estimated 导入，库出现后无 transcript 变更也能恢复 `gemini-3.8-flash` 与精确 token。 |
| 预设 lineup | Claude Zen Haiku 4.5→5.5；MoArk Claude/Codex/OpenCode/OpenClaw/Pi 全部换到 `deepseek-v4.1-flash`、`DeepSeek-V4-Pro-0813`、GLM-5.3/Flash、Kimi K3.1 Pro、Qwen3.8 Max/Flash 等上游当前目录；Codex MoArk 补 GLM-5.3-Flash、移除已下架 qwen3-coder-plus；OpenCode/OpenClaw/Pi Kimi 补 K2.7 Code HighSpeed 与 K2.6。 |
| sql.js | dev-dependency `1.14.2` → `1.15.1`（`--save-exact`）。 |

## 未实施 / 明确不做

- **OMP provider-switch（第 12 个受管应用）**：评审建议在 OMP 会话两段落地后单独立项。上游 14 提交需同时处理 `models.yml` 文本级编辑与 AiTool 整文档 YAML round-trip 的分歧（手写 anchors/flow-style 会被重排），并新增 dashboard tab；本轮不夹带。
- **Grok 分段池条**：见上，需产品决策（Cursor Sand 去重）。
- **Swift WorkBuddy 菜单栏**：按评审“Swift 菜单栏部分后置另评”处理。
- 评审“不引入”清单保持：ChatGPT 浏览器登录、cc-switch usage 页/内置 proxy、赞助预设、Home 集群、Magpie 插件生态自研等。
- 未部署 `dashboard/edge-patches` 五份 edge functions；未改版本号、未提交、未发布。

## 验证

- 定向：Kimi 23 项、pricing 96 项、edge parity 23 项、OMP sidecar 14 项、upstream session sources 19 项、WorkBuddy IPC/limits 24 项、proxy Magpie 集成 14 项、provider switch 43 项、desktop clients 24 项、quota 全部通过。
- `npm test`：4516 项，4486 通过、16 失败、14 跳过。16 项失败在 `53783df82` 的临时 worktree 中逐项复现（13 个 Codex/session 根目录 + 1 个 Codex patch 缓存 + 1 个 image roots + 1 个 Antigravity Unix socket 路径过长），均为本机 macOS 路径/socket 长度环境问题，与本轮改动无关。
- `npm --prefix dashboard test`：1199 项，1198 通过；唯一失败 `cli-sessions-page` 的 Codex 根目录用例同样在 HEAD worktree 复现。
- `npm --prefix dashboard run typecheck`、`npm run dashboard:build`、`validate:copy`、`validate:locale`、`validate:ui-hardcode`、`validate:guardrails` 全部通过。

## 风险与后续

- WorkBuddy Messages 旁路只经合成测试；真实账号若拒绝 `/v1/messages` 会自动回退 chat，但 effort 可能静默丢失，需真实账号确认。
- Kimi 官方卡编辑首次需要有效 access token；Windows 过期 token 仍要求先在 Kimi Code 用一次（与既有 quota 行为一致）。
- Kimi detached 快照保存在 `kimi-accounts.json`（0600），删除卡片会同时清掉快照；删除独立账号仍会删除 ccs 自有凭据。
- OMP sidecar 版本升到 29，首次同步会全量重建 analytics。
- 未部署 edge functions；定价修复在本地/主应用生效，leaderboard/account 系列 edge 端点仍运行旧逻辑，直到部署。
