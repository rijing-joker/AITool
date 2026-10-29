# 五上游更新评估 — 2026-10-29

对照 AiTool `dev` 的 `d75f4c640dc896d0b109b530f9169dd6cb5e5366`、[10-26 评审](upstream-review-2026-10-26.md)与[10-26 实施](upstream-integration-2026-10-26.md)。本轮只评估并记录候选，没有实施业务改动、替换核心或操作真实账号。

**建议先做兼容性和统计正确性更新，再做新应用和多账号管理。** 收益最明确的是核心 v8.0.47、Qoder 统计/额度、Codex/OpenCode MCP、Kimi 月度额度和 WorkBuddy 协议。DeepSeek Harness 会话面、Claude 官方多账号和 Ultra Fast 别名是值得引入的新功能。

## 固定快照

2026-10-29 在线读取 GitHub 后固定到以下 SHA；日期按北京时间。提交数从上次评审快照计算，包含合并、发布和文档提交，不代表可移植功能数。主线与正式发布分别标明。

| 上游 | 上次快照 | 本次主线快照 | 最新正式版 | 新提交 |
| --- | --- | --- | --- | --- |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | `905a54e8` | `f80ed15a0976f076a3f41ccdd9a202ac7d09d409` | v1.5.1 | 43 |
| [cc-switch](https://github.com/farion1231/cc-switch) | `de0a235` | `9403960f82efeef884460f4317ade14adaed9bb0` | v4.0.21；主线已有发布后更新 | 77 |
| [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) | `1d5198e` | `066ed455ffb711ca34bfcd067bdf633d505f5768` | v0.3.58 | 31 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `30780351` | `90c447d3a8727d115aa7552ec93ce023736ed492` | v8.0.47 | 62 |
| [Magpie](https://github.com/yetone/magpie) | `81a58d2` | `5143bf593aef900cc392b0255e8c722f838014a5` | v0.1.2020（`c201fe226`）；主线又有 3 个提交 | 648 |
| Magpie [社区插件](https://github.com/magpie-community/plugins) | `e513644` | `6a86762e26d3ff8e42d928c913a78f9c16da711e` | WorkBuddy 0.1.47 / Zen Free 0.1.18 | 92 |

## 优先引入

### 1. CLIProxyAPI v8.0.43 → v8.0.47（优先级高，移植代码少、验证中等）

AiTool 当前 `core-version.txt` 仍为 v8.0.43。升级外部核心可以直接获得：

- [`477605dc6`](https://github.com/router-for-me/CLIProxyAPI/commit/477605dc6deb301e587dff646f9f43ea8b58ee60)：未认证的不完整请求体不再耗尽文件描述符；共享 HTTP/RESP listener 对临时 accept 错误重试，认证前读取有期限。
- [`b74422180`](https://github.com/router-for-me/CLIProxyAPI/commit/b74422180e867ac24bf5da4820acac40099eb974)：异步 usage 保存请求身份快照，避免读到已被其他请求复用的 `gin.Context`。这与请求归属和客户端密钥统计直接相关。
- [`712e4970b`](https://github.com/router-for-me/CLIProxyAPI/commit/712e4970bc9811f36e6b0a9d87a62d54a4bbc586)：首块数据前连接关闭也正确记录取消；`aa4130e64` 避免把已返回 HTTP 200 的 Gemini 截断流当成凭据拒绝，触发错误冷却/切换。
- [`9a35fa12b`](https://github.com/router-for-me/CLIProxyAPI/commit/9a35fa12b2f388b235afec48736b7dfecfcc4de5)、[`86a1aabf0`](https://github.com/router-for-me/CLIProxyAPI/commit/86a1aabf0178be8b188cfa2c9d2fedc5fcc48a02)：Codex 临时容量限制按重试提示处理，早期 WebSocket 429 可以换凭据而保持下游连接。
- Codex commentary 历史恢复、Claude 5.5 强制工具限制、Gemini/Vertex 工具参数与思考签名转换，以及流末尾 `[DONE]` 修复。

**本轮升级有行为变化，不能只改 pin 就宣布兼容。** 新增 HTTP 响应压缩（协商后默认开启）、Codex WebSocket 压缩（默认开启）、上游 zstd 请求压缩（单独开关），涉及内存和流式行为。v8 配置新增 `server.response-compression`、Codex compression 字段；usage 内部类型新增 selection ID 和结构化截断错误分类。旧管理面是否完整兼容仍需隔离运行核对。

落点：`core-version.txt`，必要时补 `src/lib/proxy/usage-record.js` 的诊断字段。验证复用 `scripts/acceptance/proxy-core-smoke.cjs`，重点检查 ETag/If-Match、RESP AUTH/SUBSCRIBE 长连接、usage 归属/重启连续性、压缩和取消。更改 pin 与更新已安装核心是两件事。

### 2. Qoder / Qoder CN 新格式统计（优先级高，中等）

来源：TokenTracker [`2f19cd46f`](https://github.com/xiufengsun/TokenTracker/commit/2f19cd46fcb88012fecec0ee094d0bad6c2b7219)。

本地 `src/lib/rollout.js:6575` 仍以 `!base && !isBillable` 跳过记录。Qoder 0.4.x 的免费模型会写 `billable:false`、正 credits、零 token，因此真实调用完全消失。Node 24 临时 fixture 已复现：该主会话行产出 **0 行队列**；另外，有 token 的 subagent 行当前贡献 **conversation_count:1**，会放大会话活动数。

建议整组移植：以 token、billable、有效 credits 三种信号判断活动；`credits` 与 `original_credits` 取有效较大值；subagent 只贡献 token；防止异常时间戳使整来源解析中断。没有权威 token 的调用只记活动，继续保持 token 与费用为 0，不推导 credits→token/USD。

落点：`rollout.js` 的 `normalizeQoderNewTokens` / `parseQoderNewIncremental`，沿用 AiTool 自有项目桶、游标和共享队列保护。验证新旧格式、subagent、重写补 token、连续两次 sync。

### 3. Qoder 0.4.x 桌面额度（优先级高，小至中等）

来源：TokenTracker [`c30d1e3b1`](https://github.com/xiufengsun/TokenTracker/commit/c30d1e3b13b92b5681265076c5ad26fbf4e9d01f)。

`src/lib/qoder-limits.js` 没有 `main.log` / `qoderUsage` 分支，仍只扫描旧 renderer 日志。上游增加 `main.log` 中的账号额度汇总，支持倒序分块读取、新旧日志兜底、过期结果过滤和未变化空扫描缓存。可以修复“客户端已登录，额度页仍不显示”的一类问题。

建议与第 2 项同批实施。保留现有 CN CLI 额度与 add-on 分离语义，不把桌面额度冒充 CLI 官方窗口。

### 4. Codex MCP 去掉其他客户端字段（优先级高，小）

来源：cc-switch [`cfc64971f`](https://github.com/farion1231/cc-switch/commit/cfc64971f9172a17e533ea4e156bd0691d851c74)。

本地 `src/lib/provider-switch/mcp.js:437` 的 `specToTomlEntries` 会透传未知字段。纯函数检查确认 Codex 输出仍含 `timeout:900000` 和 `autoApprove:[...]`；上游指出这些字段在 Codex 被忽略，严格加载会拒绝配置。

建议只在 Codex 投影删除这两个字段，SSOT 和 Grok/其他应用仍保留；保留 Codex 原生 `tool_timeout_sec` / `startup_timeout_sec`，不猜测跨客户端 timeout 单位。顺带在 MCP 面板提示 SSE 投影到不支持 SSE 的客户端（cc-switch `c2110ebb0`），本地已有 Antigravity 拒绝逻辑可复用。

### 5. OpenCode 2 原生 MCP 布局（优先级高，中等）

来源：Magpie [`fce0d8475`](https://github.com/yetone/magpie/commit/fce0d84756d6d6a12eb07ee9391ceb26df2c9475)。

OpenCode 2 使用 `mcp.servers.<name>`，同时兼容旧 `mcp.<name>`。AiTool 在 `mcp.js:596` 写旧顶层，在 `:883` 按顶层枚举导入；新布局里的 `servers` 会被当成单个服务器。纯函数 fixture 复现错误：`OpenCode MCP server 'servers' has no command`。

建议兼容双布局：新布局同名项优先，写入跟随原布局，移除时清理两处同名项；区分真正名为 `servers` 的旧服务器。原生新布局不应机械写旧版 `enabled` 字段，也要保留用户禁用状态。同步检查 MCP 工具过滤与 diagnostics 的读路径。

### 6. Kimi Code 月度额度与新响应（优先级高，小至中等）

来源：Magpie [`296f66a74`](https://github.com/yetone/magpie/commit/296f66a74bbd4b242acdb877d49fe4abe605416b)，**该提交在 v0.1.2020 之后的主线**。

新响应含 `usages.limit_5h`、`limit_7d`、`limit_month_total`，窗口用 `used_ratio` / `reset_time` 表达。AiTool `kimi-accounts.js:866` 只读旧 `limits` / `usage`，新格式可能被显示成没有额度，甚至落到“未订阅”文案。

建议添加新格式并保留旧响应；同窗口新格式优先，新增 Month 行。`limit_month_code` 是月额度内部的代码用量份额，不能当另一份独立额度加总。对共享的 Kimi Coding Plan 查询入口也做响应一致性检查。

### 7. WorkBuddy 0.1.34 → 0.1.47 协议增量（优先级中；重度使用时提高，小至中等）

本地适配器已有 Messages 旁路与 401 单次续期；这些是已整合内容。后续新增值得移植的是：

- [`7f99447ed`](https://github.com/magpie-community/plugins/commit/7f99447ed26a743d0f9156faac8e07ac5a6fe3f1)：历史 assistant 的 `reasoning_content` / `reasoning_details` 转为 WorkBuddy 原生 `reasoning`，避免多轮历史的思考内容被丢弃。
- [`b2fe48ea2`](https://github.com/magpie-community/plugins/commit/b2fe48ea2e8bf6c5beda207e169f2eecdc308b5c)、[`b08a6c1bc`](https://github.com/magpie-community/plugins/commit/b08a6c1bceaf7c1583de4ad9302b58d027f3952a)：国内/国际请求头对齐当前 5.9.3 客户端。本地 `headers()` 仍固定 5.5.6。
- [`1e7122e16`](https://github.com/magpie-community/plugins/commit/1e7122e161b7277c042cdd6e98eee5ba5516f14b)：会话/turn ID 按账号隔离。本地 `workbuddy.js:449` 的 HMAC 只依赖 adapter token 和 conversation，账号变化后 ID 不变。
- [`e460dae2f`](https://github.com/magpie-community/plugins/commit/e460dae2f059c4d5cddb1ebd35eb0b3e32f6d267)：没有 cycle total 的 package 按钱包余额表达；本地 `quotaOf()` 只接受完整周期额度，需避免遗漏或伪造百分比。

另外可评估默认 effort、聊天 gzip 和大请求的分段 hash/单次解析优化。协议改动需要真实账号验证；只选择字段/认证/传输修复，继续保持现有指令文本不被重写。钱包窗口与桌面 wbipc 额度是两个入口，不能不加区分地合并。

### 8. 经典 TRAE CN 目录发现（优先级中，小）

来源：TokenTracker [`72d83158a`](https://github.com/xiufengsun/TokenTracker/commit/72d83158acad64cf583495f9b4bb05b3ca2026d5)。

本地 `trae-cn-config.js:34` / `:87` 只认 `TRAE SOLO CN`，上游增加经典 `Trae CN` 目录。建议按明确的优先顺序探测，显式路径覆盖仍优先，权限错误保留诊断。对使用经典 CN 客户端的人是直接修复；继续保留现有 usage opt-in。

### 9. GPT-6.1 Terra 定价（优先级中，小）

来源：TokenTracker [`2e774e82f`](https://github.com/xiufengsun/TokenTracker/commit/2e774e82fa5597bb9ab59c521ad2d29495c64c7d)。

本地无 curated 条目，纯函数查询返回 `unpriced`。建议补 exact/fuzzy 和长上下文/Fast 子集计费，并逐字同步五份 edge 定价。上游给出的 Standard 输入/输出/缓存读为 $1/$5/$0.05 每百万 token；**本轮只核对上游源码，实施前应复核官方价格与上下文规则**。未公布的 Ultrafast 费率不要推导。

## 值得新增的功能

| 候选 | 增量价值和本地状态 | 工作量 / 建议 |
| --- | --- | --- |
| **DeepSeek Harness 会话浏览** | TokenTracker `64bbaa5d5` 新增 `dsh-session.js`；cc-switch `3fc8794cf` 新增 DSH 管理和正文读取。本地已有 `parseDshIncremental` 与 sync/status，但 `session-analytics.js`、Sessions 来源筛选及 `session-sources.js` 未接 DSH | 中；优先接统计会话列表与只读正文，复用现有根目录/revision/缓存保护。之后再评估 provider-switch 的 `~/.dsh/config.yaml` profiles、MCP、prompts/skills 和启动入口 |
| **Claude 官方多账号切换和账号额度** | cc-switch [`4dc05a9aa`](https://github.com/farion1231/cc-switch/commit/4dc05a9aa3692847e640c7d1064d081f20518e05) 及后续修复：账号绑定官方卡、登录切换、每账号配额、隔离终端、恢复。本地有 Kimi 多账号，但没有等价的 Claude 账号管理 | 大；如果常切多个 Claude 订阅，收益很高。独立立项，移植最终修复态，覆盖平台凭据存储、登录隔离、锁、配置/身份快照和恢复 |
| **代理别名的 Ultra Fast** | EasyCLIProxyAPI [`0ca8093af`](https://github.com/router-for-me/EasyCLIProxyAPI/commit/0ca8093af4d774e793e6cf108485c57246bcdd1f)。本地编辑器仅布尔 Fast，`alias-mappings.js:240` 固定写 `service_tier:"priority"`；现有 Ultrafast 统计不等于支持创建别名 | 小至中；增加 Standard/Fast/Ultra Fast 选项，同步默认别名、编辑回读和后端验证，保留旧 Fast 数据 |
| **手动刷新核心模型目录** | CLIProxyAPI [`10417e5b6`](https://github.com/router-for-me/CLIProxyAPI/commit/10417e5b6b85461e8d7072a6fea6ad9f781b1f0f) 新增 `POST /v8/management/models/refresh` 与 `/routing/model-definitions/refresh`；本地目前只有免费 adapter 的刷新 | 小；升级核心后接一个显式刷新动作，返回更新来源/失败情况，并为旧核心做能力判断 |
| **Codex 模型目录拖拽排序与子代理选择器** | cc-switch `05034a4e4` 支持 catalog 行拖拽；EasyCLIProxyAPI `758d9045f` 支持子代理模型 picker、开关/并发数/中断选项。本地已管理默认子代理模型/effort，但模型字段还是文本输入，缺完整设置界面 | 小至中；先做排序与模型选择器。其他选项要明确哪些属于用户全局，保持现有“provider 只拥有自己的 agents 字段”约定 |
| **WorkBuddy API key 登录 / Free models only** | 社区插件 `4bde462e2` / `18268848d`，可减少浏览器登录依赖，并给不希望花 credits 的使用者明确选项 | 中；按需做，免费目录必须来自可信的实时能力/价格，不按模型名字猜 |
| **OMP provider-switch** | 上次已延期的能力，本轮已有会话两段接入，管理面仍缺 | 中至大；这是旧候选而非本次新功能。可接着做，但需解决 `models.yml` 保留手写格式/锚点及 profiles 路径问题 |
| **MCP Hub** | Magpie `e0ea15b8e`：一个 MCP 入口聚合资源库服务器，按需运行后端 stdio server，减少客户端配置数量 | 大；工具多时有价值。涉及认证、工具命名、并发、进程生命周期和投影迁移，宜单独设计 |
| **共享 skills 移交/归还管理权** | Magpie `da8039368`：将 `~/.agents/skills` 迁入资源库，才能真正按 agent 关闭。本地会导入该目录，但只移除应用投影无法阻止客户端继续从共享目录发现 | 中；先在 UI 表达实际生效范围，再做显式移交/归还及恢复记录，避免开关状态与客户端行为不一致 |

## 界面更新可选取，整套样式不整体移植

EasyCLIProxyAPI 的 `f9b18a56c` 已把 miaomiao 改版合进主线，这次不再是“前端零改动”。主要变化是主题 token/语义颜色、表面与搜索控件、子页面导航、账户状态和插件更新 UI。AiTool 已有自己的 React/Tailwind/设计系统，适合选择交互与状态表达，按本地 token 实现。

- TokenTracker Sessions 骨架屏（`9f09f6e8e`）与效率列可达性（`e212fd260`）：改善首次加载和窄屏阅读；当前首次加载仍以 spinner 为主。
- ZCode reset-card 的折叠分区/倒计时条（`e20958ced` + `061a73a58` 最终态）：如果额度页太长，值得借鉴；空 bank 行隐藏规则要一起取。
- EasyCLIProxyAPI 插件更新检查、单独/批量更新（`78d0e8060`）：只对 AiTool 实际管理的插件入口评估，已安装 Magpie 的插件仍交给 Magpie 管理。

## 已覆盖、分歧及低收益项

- cc-switch `74a98fddc` 的 `.env export KEY=value`：本地 `envfile.js` 已支持；`882e7a6a4` 的“无激活 prompt”快照：本地 profiles 已区分 `""` 与 `null`。不用重复移植。
- TokenTracker Ultrafast 会话筛选补列：本地 `session-analytics.js` 与 `sessions-insights.js` 已保留 Ultrafast 子集；离线设备 transfer 是此前未引入的模块。
- cc-switch `644f56642` 的 Kimi 请求时间修复：上游修的是批量提交 message 的时间；本地解析 `step.end`，不能直接认定为同款问题。保留真实跨半小时/跨日 wire 检查项。
- Magpie skills 非 ASCII 名称碰撞：本地 `parseSkillMeta` 以目录 basename 为 id，已有不同的去重机制；不能只按上游问题描述认定需同样修复。
- Zen Free 旧 UA 被拒绝：本地已用 `opencode/latest/2.0.29/cli`，该 UA 修复已覆盖。上游最新的环境目录校验/258624 context floor 可作为单独实测项，不能把它的 prompt 补写机制直接搬入本地 adapter。
- 不引入赞助/SEO 徽章与推荐排序、上游发布/支付运营、cc-switch 内置代理、Claude Desktop 专属配置、Magpie 的整套网关/账号亲和/正文日志/自动指令改写。各自的协议核心修复通过外部核心或已安装 Magpie 获得。
- TokenTracker 慢 account-view 后台完成（`0c279d967`）与社区缓存完整性（`f15b3f643`）本地尚未跟进，确有对应旧逻辑；如果仍使用可选云账号/社区页，属于有收益的小修复。该 fork 的本地工作流收益较低，排在本轮主列表之后。
- 10-26 五份 edge 定价仍记录为未部署。本轮没有检查线上部署状态，不能把本地定价正确等同于云端已经正确。

## 推荐实施顺序与验证边界

1. 独立升级/验证 v8.0.47，随后接手动模型刷新。
2. 同批修 Qoder 统计+桌面额度、Codex/OpenCode MCP、Kimi 额度与 TRAE 目录。
3. WorkBuddy 协议修复；补 Terra 定价与对应 edge 镜像。
4. DSH 会话面、Ultra Fast 别名与 Codex 模型选择体验。
5. 按使用需求分别立项 Claude 官方多账号、OMP 管理、MCP Hub/共享 skills 管理权。

证据来自 GitHub compare、固定 SHA 的 raw 源码、关键提交 patch 与本地源码直接对照。Magpie **648 条提交清单已分页完整获取，并按模块筛选**；其 aggregate compare 的文件列表达到 300 项上限，文件级评估为重点模块审阅，没有声称完整审完全部变更。其余 compare 文件列表未达到 300 项上限，关键被省略的 patch 用固定 SHA 源码补读。

Node 24.22.0 合成检查确认：Qoder 零 token 免费调用遗漏、subagent 计活动、Codex 外来 MCP 字段透传、OpenCode 新布局误识别、Terra 未定价。fixture 仅写 `/tmp`；未读写真实账号配置、未发起推理/登录/配额请求、未运行新版核心。本轮只有文档改动，未运行完整业务测试。上述兼容性/协议更新仍需实施后的定向测试与必要实测。
