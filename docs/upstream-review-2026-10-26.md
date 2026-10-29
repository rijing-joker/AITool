# 五上游更新评估 — 2026-10-26

对照 AiTool `dev`（`53783df82`）与 [10-24 评审](upstream-review-2026-10-24.md)、[10-24 实施](upstream-integration-2026-10-24.md)。本轮为候选更新评估，未实施任何集成、未改业务代码。四个本地克隆均已 fetch 到最新；Magpie 经 GitHub API compare/releases 读取。

## 本次基线

| 上游 | 上次固定快照 | 本次最新 | 新提交 |
| --- | --- | --- | --- |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | `5c822b59`（v1.4.9） | `905a54e8`（v1.4.11） | 18 |
| [cc-switch](https://github.com/farion1231/cc-switch) | `d8983bb`（v4.0.19） | `de0a235`（v4.0.20） | 42 |
| [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) | `1d5198e`（v0.3.51） | `1d5198e`（无变化） | 0 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `8289ec4c`（v8.0.41） | `30780351`（v8.0.43） | 29 |
| [Magpie](https://github.com/yetone/magpie) | `dd1e8822`（v0.1.1364） | `81a58d2`（v0.1.1549，10-25）；社区插件 `e513644`（workbuddy 0.1.34 / zcode 0.1.30） | 247（社区另 +60） |

## 优先引入

### 1. CLIProxyAPI 核心 pin：v8.0.41 → v8.0.43（P0，小）

全范围（`8289ec4c..30780351`，69 文件 +1918/−643）兼容面核对结论：**Management 端点零删改**（唯一新增是 `27f3abfb` 的 `POST /oauth/auth-url`，既有 GET 的 additive 变体）；**RESP usage 载荷、config.yaml 结构、auth 文件格式、ETag/If-Match 语义全部零变化**。GET `/oauth/auth-url` 收紧为 query 传 `proxy_url` 返 400，AiTool 从不调用该端点。建议直接跳到 v8.0.43（v8.0.42 无独立留存价值）。

升级即修复（无需 Node 改动）：

- `30780351` AI Studio 中继流按帧翻译 —— 旧版每块只处理首帧，**尾部 finish reason 与 token usage 被丢弃**，直接影响 usage 桥收到的流式记录完整性。
- `ab139b45` Kimi K3.1 Pro 变体 thinking replay（AiTool 刚做 Kimi 管理，直接受益）。
- `da21f1e5` antigravity 非流式工具签名恢复 + 流式 call indices。
- `bdde391d` Codex/OpenAI→Gemini 流 finishReason 保留；`b2fda98e` Gemini 数组占位不再覆盖真实 `items`。
- `21553509` 凭据重新登录后恢复轮换（清 invalid_grant、重置 backoff）；`32dd2c86` watcher 持久化 auth 保留文件快照绑定。
- `179d43dc` 请求日志文件名路径穿越（安全）；`3e7a21e2` openai duplex 重授权隔离（安全）；`6340fe43` codex duplex 绑定请求模型；`90fe5b23`/`0fe4cc2c` 流取消如实上报。
- `0c61b12c` xai historical additional_tools 去重。

可选新能力：`27f3abfb` 会话级 OAuth 代理 + 逐账号持久化（登录会话可指定 proxy_url，成功后写入该账号 metadata）——AiTool 目前不经核心发起 OAuth 登录，暂不暴露；未来做"经核心登录"入口时是现成能力。插件宿主系列（`c9af5290`/`e42eee6e`/`44d1ddf5`/`9d08f0d4`/`e48d780f`/`35e834da`）为插件执行路径对齐直连路径的修复，AiTool 零配套改动。`ba06ec58` Vertex 无 location 凭据端点 `us-central1`→`global` 是唯一预期行为变化（抽查项）。Home/Redis 系列维持"不引入 Home 集群"决策，属升级搭车修复。

落点 `core-version.txt`；验证：复用上轮方法 —— 隔离下载（GitCode 镜像，Commit `30780351` 校验）→ `scripts/acceptance/proxy-core-smoke.cjs` 全过 → 管理面 ETag/If-Match 往返 + stale revision 拒绝 → usage 桥 `SUBSCRIBE usage` 记录 schema 逐字段比对 → 定向抽查 antigravity/Kimi K3.1/devin `swe-2-lightning`/Vertex global。

### 2. 定价修复四件套（P1，小-中；两项是错误计费）

| 上游 | 内容 | AiTool 现状（已验证的坑） |
| --- | --- | --- |
| TokenTracker `b4ce9c84` | `-free` 后缀跨源按 $0：`endsWith("-free")` 检查移到 curated/litellm exact 之后、alias/fuzzy 之前 | `matcher.js:276-291` 仍是旧形态（cline `:free` + opencode `-free` 两个早退在 exact 之前），**其他源报出的 `*-free` id 会落 fuzzy 继承付费费率**；curated 显式 `-free` 条目被早退遮蔽 |
| TokenTracker `f4df1361` | kimi-k2.8 / kimicoding / k2.8 保持 unpriced（matcher miss-guard + edge ZERO_PRICING guard） | **无此 guard**：`kimi-k2.8`/`k2.8` 经 fuzzy `"kimi"→kimi-k2.5`（matcher.js:774）错按 k2.5 费率 |
| TokenTracker `905a54e8`（= cc-switch `c3e54a4` 同款，取 TokenTracker 官方 USD 价） | kimi-k3.1-pro $2/$10/写$2/命中$0.2、highspeed $4/$20/$4/$0.2，紧凑别名 + fuzzy 顺序防继承 kimi-k3 | curated **无 k3.1 条目**且 fuzzy 表有 `match:"kimi-k3"`（:766）——`kimi-k3.1-pro` 会被 k3 费率吞掉 |
| TokenTracker `1e9dbb32` | qwen3.8-max 新加坡国际 $2/$6/read 0.17/write 2.5（max/-0902/-2026-09-02 三条 exact）+ matcher exact 前移、SKU 后缀阻断（preview/next/exp…） | curated 仅 qwen3.8-flash；flash regex 仍在 curated exact 之前；`lookupContainedExactCaseInsensitive` 无 SKU 后缀阻断 |

实施顺序建议先修错误计费（`b4ce9c84`/`f4df1361`）再补费率（`905a54e8`/`1e9dbb32`），一轮共享一次 edge 同步。落点 `src/lib/pricing/curated-overrides.json` + `src/lib/pricing/matcher.js` + edge canonical（`dashboard/edge-patches/tokentracker-leaderboard-refresh.ts`）逐字同步 4 镜像（`test/edge-pricing-parity.test.js` 会拦漂移）+ `test/pricing.test.js`；完成后部署 edge functions。

### 3. Claude 会话标题/摘要跳过本地命令输出（P1，小；cc-switch `1a3057d`）

上游在标题与 summary 两处跳过 `<local-command-stdout>`/`<local-command-stderr>`/`<task-notification>` 注入消息。AiTool **同款 bug 已验证**：`sessions.js:499` 标题只排除 caveat 与 `<command-name>`，一条 `<local-command-stdout>…` 用户消息会被当成 firstUserMessage；`:513-515` summary 只查 `isMeta`，尾部 `/model` 的 stdout 会成为摘要。落点 `src/lib/sessions.js` `claudeParseSession` 两处循环 + 移植上游测试用例。

### 4. OMP（oh-my-pi）第一、二段：会话面（P1，小-中 + 中）

omp 是 Pi 的活跃分叉（cc-switch 上游以 Pi 管道承接、TokenTracker 同期把它加进 Sessions 浏览器，生态在推）。AiTool 的 analytics/sync 面已支持 omp（`rollout.js:16295` `parseOmpIncremental`、`omp-hook.js`、SUPPORTED_PROVIDERS），**Sessions 页与 CLI 会话读取是盲区**：

- **Sessions 页 sidecar**（TokenTracker `9cbe2fd5`）：`src/lib/omp-session.js`（480 行）依赖在 AiTool 全部就绪（`resolveOmpAgentDir`/`resolveOmpSubagentFiles` 已导出、`jsonl-lines.js` 已有），可近原样拷贝；`session-analytics.js` 接线需按 AiTool 现状重放（SIDECAR_VERSION 28→29，一次 sidecar 全量重建）；dashboard 三处（`sessions-api.ts`/`sessions-insights.js`/`SessionsPage.jsx` SOURCE_FILTERS）可直接抄。
- **CLI 会话第 8 个只读来源**（cc-switch `e88a9fa` 证明 omp 会话格式与 Pi 同构）：`session-sources.js` 加 `omp` —— roots（`~/.omp/agent/sessions` + profiles + `OMP_PROFILE` 等价物）复用 pi 行解析器；`9bacd1d` 的项目图片规则照抄。

### 5. WorkBuddy 订阅额度（P1，中；TokenTracker `c6002bed`+`ba1ff137`+`f4717c7b` 最终态）

AiTool **完全没有 WorkBuddy limits 行**（`LIMIT_PROVIDER_IDS` 17 项、`usage-limits.js` 零引用、copy.csv 无对应 key），而移植依赖齐备：`resolveWorkbuddyHome`（rollout.js:10610）、`withAbortableProviderTimeout`（usage-limits.js:228）、home 约定与 `desktop-clients.js` 一致。机制是 wbipc 本地认证 IPC（endpoint 发现文件 → HMAC ticket → unix socket / named pipe 上的 JSON-RPC，白名单 3 个只读 billing 路径）+ CN/国际两版合并单行（可用者优先、CN 决定性胜出、永不加总），纯 Node 实现，两个文件可近原样拷贝。注意三提交取最终态（单 `workbuddy` 键 + `showCreditDetail`），跳过双行中间态；landing 计数文案 17→18 是 AiTool 自有版本需改写；未装 WorkBuddy 桌面端时 `configured:false` 无害。Swift 菜单栏部分后置另评。

### 6. WorkBuddy Claude 模型走 Messages 端点 —— 先验证（P1，小；magpie-community `ba343b8` 0.1.32）

社区插件把 WorkBuddy 的 Claude 系模型改走 Messages 端点（effort 含 max 被尊重）。AiTool `src/lib/proxy/extensions/workbuddy.js:258` 固定发 `/v2/chat/completions` —— 若 WorkBuddy 端 Claude 系模型的 reasoning effort 仅在 Messages 生效，已上线的 WorkBuddy 订阅推理可能静默丢 effort。**先实测**，确认后在适配器内给 Anthropic 系模型加 Messages 旁路（小改）。

## 大件评估

| 候选 | 来源 | 评估 |
| --- | --- | --- |
| **OMP provider-switch 第 12 个受管应用** | cc-switch `c8945d2` 系列（14 提交） | `~/.omp/agent`（`PI_CONFIG_DIR`/profiles），管理 `models.yml` 显式 `providers` + `mcp.json`，默认模型读 `config.yml`；复用 Pi 的表单/会话/MCP/skills 管道。落点 `additive.js`/`paths.js`/`mcp.js`/`skills.js`/`prompts.js` + dashboard tab。**必须记录的分歧**：上游 models.yml 是文本级编辑（只动自己那一条字节，遇 anchors/flow-style 拒绝改写）；AiTool additive 引擎是整文档 YAML round-trip，手写锚点会被重排 —— 实施时要么仿上游加检测拒绝写入，要么在文档明确。安装/更新生命周期（omp.sh installer，不假设 Bun）AiTool 无对应面，可不移植。建议在 1、2 段落地后单独立项。 |

## 小项与检查项（P2）

| 项 | 来源 | 说明 | 落点 |
| --- | --- | --- | --- |
| Kimi 账号"无订阅"显示 | cc-switch `c91aa77` | AiTool 同款缺口：`kimi-accounts.js:707` 空 tiers 返回 valid，卡片渲染为空白像查询失败 | `provider-kimi-accounts.jsx` + copy.csv 6 语言 |
| DeepSeek 余额语义 | cc-switch `b9f317a` | AiTool 同款：`quota.js:212-221` 把 `is_available:false`（余额不足，key 仍有效）渲染成"Account unavailable"红行；isValid 应只交给 401/403，余额 ≤0 走红字金额 | `quota.js` + `provider-quota-line.jsx` |
| Kimi 官方卡模型编辑与"从 Kimi 移除" | cc-switch `6265294` | AiTool 官方节点 CRUD 全拒绝（`kimi.js:224-245`），Kimi 上新模型只能重登；上游用账号自己的 token 刷 `/models`，移除卡片保留凭据可恢复 | `kimi-accounts.js`/`kimi.js`/`api.js`/编辑对话框 |
| Pi/omp 行 apiKey `$NAME` 出站解析 | cc-switch `dcdcbcb` | AiTool 用 Pi 行 key 外呼的唯一路径是模型抓取；`apiKey: "$ENV"` 字面量会被当 Bearer 发出（`!command` 永不执行） | `provider-switch/api.js` fetchModelList 入口 |
| Grok 分段池条 | TokenTracker `1c90cbd7`+`1b50475c`+`a9a100fe` 最终态 | AiTool 现为纯文本 product_shares 行（10-21 方案），两个正确性修复针对的分段 UI bug 在 AiTool 不存在；若升级分段 UI 必须取五提交叠加最终态并改读扁平 `product_shares`，需一并决策 Cursor Sand 去重 | `usage-limits-provider-specs.js` + `UsageLimitsPanel.jsx` + `grok-limits.js` |
| 展开组键盘焦点环 | TokenTracker `bdfd9c6d` | AiTool `ToolGroup` 非 header 变体（role="button" div）确无 focus-visible ring，同款问题 | `UsageLimitsPanel.jsx` 一行 className |
| WorkBuddy 自写 models.json 诊断误报 | Magpie `5e0d7c0` | WorkBuddy 启动后自存 models.json 会让投影诊断常驻"需重启"；AiTool desktop-clients/applied 诊断同症状，低成本核对 | `proxy/desktop-clients.js` |
| Magpie 检查项 | `c8901d4`/`ef1a203`/`a60493a` | auto 分类器对未知能力档请求 no reasoning；agy 429 按响应 reset 时间休眠（AiTool 侧等价逻辑）；Codex-in-Claude-Code 归属修正 | 各对应模块先确认有无同款 |
| agy 子代理模型恢复验证 | cc-switch `309c9c5` | AiTool 已有 gen_metadata join 机制（读 field 19），核心问题应已覆盖；用真实含子代理会话验证 + 确认库读失败时下轮可恢复。field 21 分档计价与 AiTool 剥档位词是产品分歧，不跟 | `rollout.js` agy 解析器 |
| 预设 lineup 对照 | cc-switch `50a9d10` | 上游刷到 opus-5.5/gpt-6.1-sol/glm-5.3 等，对照 AiTool `presets.js` 按需补 | `presets.js` |
| sql.js dev-dep bump | TokenTracker `47e1f0e5` 部分 | 1.14.2→1.15.1，全量测试兜底 | package.json |

## 不引入（本轮明确）

- cc-switch：managed ChatGPT 浏览器登录（`c72c82c`，依赖未移植的账号中心层；未来若做多账号，`browser.rs` 628 行是完整参考）、Copilot 表单自动路由提示（`bd50984`，AiTool Copilot 走自有 `proxy/copilot.js`）、usage 页 tab 计数（`28a2ebc`）、内置 proxy 修复（`de0a235`/`7f9cd9e`）、应用页分组/拖拽排序（`5bc562c`/`b71141a`/`ba6a8a5`，AiTool tab 已 dnd-kit 排序且无安装面）、土耳其语（`9decd60`）、Linux 窗口拖拽（`e8ae28b`，AiTool desktop 用默认装饰无自定义拖拽区）、Pi 表单折叠（`5f64264`）。
- TokenTracker：payment SDK pin（`46a54eeb`，fork 不运营托管支付）、release ×2、Grok 池条/WorkBuddy 的 Swift 菜单栏部分（后置单独立项）。
- Magpie：zcode 0.1.25–0.1.30（设备指纹语义从隐私角度知晓即可）、search1api/gcp-ai/cowork/joycode/kimi-desktop 等新插件与来源、pf-serve 本地 PII 模型、路由 UI/性能、magpie-setup 技能 —— 全部经"已安装 Magpie"路径自动获得，AiTool 不自研。
- CLIProxyAPI：Home 集群/Redis 系列（不启用不激活，升级自动搭车）。
- EasyCLIProxyAPI：无增量，零动作。

## 验证边界

本轮读取四个本地克隆 diff（均已 fetch 到 2026-10-25 的 origin/main 或 upstream/main）、GitHub API（Magpie compare dd1e8822...main 与社区插件 compare f6588420...main，API 返回的提交/文件列表有截断，Magpie 247 提交为版本号级+采样覆盖）与 AiTool 源码对照（grep/read，关键论断带 path:line）。未运行 v8.0.43 二进制、未做 WorkBuddy IPC 实测（本机未确认装 WorkBuddy 桌面端）、未验证 Kimi/qwen 官方价格页、未改任何代码。

## 来源

TokenTracker `git log 5c822b59..origin/main`；cc-switch `git log d8983bb..origin/main`；EasyCLIProxyAPI `git log 1d5198e..upstream/main`（空）；CLIProxyAPI `git log 8289ec4c..upstream/main`（v8.0.42 = `bc064340`，v8.0.43 = `30780351`）；Magpie [compare dd1e8822...main](https://github.com/yetone/magpie/compare/dd1e8822...main)、[releases](https://github.com/yetone/magpie/releases)（现仅保留最近 4 个：v0.1.1546–1549）、[社区插件 compare](https://github.com/magpie-community/plugins/compare/f6588420...main)。
