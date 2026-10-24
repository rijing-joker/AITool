# 五上游更新评估 — 2026-10-24

对照 AiTool `dev` 的 `a6ac4b80d` 与 [10-21 整合记录](upstream-integration-2026-10-21.md)、[Magpie 整合](magpie-integration.md)。这是候选更新评估，没有实施任何集成。上游克隆均已 fetch；EasyCLIProxyAPI/CLIProxyAPI 本地 fork 已补 `upstream` 远端（router-for-me）。

## 本次基线

| 上游 | 上次固定快照 | 本次最新 | 新提交 |
| --- | --- | --- | --- |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | `4cb82c70`（v1.4.7 后） | `5c822b59`（v1.4.9） | 18 |
| [cc-switch](https://github.com/farion1231/cc-switch) | `0a41250d`（v4.0.17 后） | `d8983bb`（v4.0.19） | 55 |
| [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) | `9fc0a33b`（v0.3.50） | `1d5198e`（v0.3.51） | 4 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | `ce07d189`（v8.0.37） | `8289ec4c`（v8.0.41） | 44 |
| [Magpie](https://github.com/yetone/magpie) | `86254d40`（v0.1.1318 时代） | `dd1e8822`（v0.1.1364） | 115（社区插件仓库另 +30） |

## 优先引入

### 1. CLIProxyAPI 核心 pin：v8.0.37 → v8.0.41（P0，小）

四版 44 提交里 Management API 端点零增删改、无新提供商类型、RESP usage 载荷仅新增 omitempty 的 `effective_service_tier`。与 AiTool 直接相关的修复：

- `8289ec4c` interactions 协议流式 usage 合并保留 token 语义。旧版把已含 cache 读的 `input_tokens` 按 Claude 语义重建 breakdown，cache 份额被重复计入 input —— AiTool `pricing.js` 的 `freshInputTokens` 对 v2 行做 `input - cacheRead`，旧行为下**插件宿主上游的流式请求费用被高估**。升级即修复，AiTool 代码无需改。
- `888f2382` RESP 协议边界校验（64KiB 帧/行、1024 元素数组、整数溢出、panic 恢复）—— AiTool usage-bridge 订阅的同一协议面；bridge 发送的 AUTH/SUBSCRIBE/LPOP 均为短命令，不受新限制影响。
- `4138edb1` 请求级 401 错误规则不再触发 token 拒绝/刷新，`-and-cooldown` 只施加临时 cooldown —— 与 AiTool 已上线的单凭据错误规则 UI 语义对齐。
- `8bd17955` Management OAuth 登录/token 保存 data race 修复；`57a12996` auth 目录不可读时保留既有凭据；`633a294f` Go 1.26.10 + 依赖升级。
- `b90190db`/`07b5a7a1` usage 记录新增 `response_service_tier`/`effective_service_tier`（可选跟进：Requests 记录展示服务层级）。

落点 `core-version.txt`；验证：复刻上一轮 v8.0.37 的隔离管理面兼容检查（auth-files、v8 config ETag 往返、批量刷新）+ usage 桥全链路实测。pin 变更不替换运行中的核心（本机上次记录为 8.0.35）。

### 2. TokenTracker 正确性修复（P0，小-中）

- **`56e21b4a` serve 静态文件 FileHandle mid-open abort 泄漏**：客户端在 `open`/`stat` await 期间断开时 close 监听尚未注册，句柄永不释放。AiTool `src/lib/static-server.js` 是带预压缩协商的分叉实现，同样的"监听过晚"模式且 await 点更多（变体 stat + 重开），更易触发。需适配 HEAD 分支与变体重开时序，测试要改写。
- **`5c10cac1` undici 8.11.2 → 8.12.2**（CVE-2026-87018）。
- **`0dce343a` Codex Ultrafast 6x 计费**（P1，中）：`codex-service-tier.js`/`codex-rollout-parser.js`/`rollout.js`/`pricing/index.js`（`tierPremium` 重构）/`curated-overrides.json`（gpt-6-astra、gpt-6.1-sol `ultrafast_multiplier: 6`）。AiTool 的 `session-analytics.js` SIDECAR_VERSION 已领先（27），加列后需 bump 到 28 并接受一次 sidecar 重建；`rollout.js` 的 `totalsKey` 有自有 `cache_creation_1h` 前缀，`|u:` 段需逐段对位。上游测试（`codex-ultrafast-pricing.test.js`、`session-cross-day-usage` 新 case）可移植。
- **`0dce343a` 内 Haiku 5.5 fuzzy 条目**：费率与 edge 镜像 10-11 已整合，仅缺 curated `fuzzy` 两条 match（防 dated 变体落到 haiku-4-5 费率）。小。
- **`256ef46d` TokenGalaxy WebGL 运行时 fallback**（P1，中）：`disposeGalaxy`/`failToStatic`/`webglcontextlost`；AiTool 版本只兜底构造失败。Sentry/native-qa 部分不适用。
- 小件：`5447f31f` reinstall 测试 `timeout: 300_000`；`256ef46d` 内 notify-debug-log 测试稳定化（AiTool 现版跑两次完整 init，可顺带提速）；`0dce343a` 内 sync 上传摘要三态消息（依赖已有 `resolveDeviceTokenPresence`）；`2c1e5aa9` dashboard 依赖 bump（lucide-react 1.48→1.59 跨度大，需全量测试）。

### 3. cc-switch 修复移植（P0-P1，小）

- **`b5aa7fb` agy 直连 Google 配额 UA**：Google `retrieveUserQuotaSummary` 按 User-Agent 决定返回档位，`aitool (antigravity)` 只回 Claude+GPT，Gemini 档仅回给 `antigravity/cli/<版本>`（1.2.0+）。AiTool `src/lib/provider-switch/agy-accounts.js:90` 正是旧写法 —— 同款 bug。改为 `aitool (antigravity/cli/<agy 版本>)`，版本取 `agy --version`（进程内探测一次，失败回退 1.4.6）。
- **`ea8bc2c` Claude 会话按最后 `/cd` 位置分组**：读取 transcript 尾部 64KiB 内最后一条 `type:"relocated"` 记录的 `relocatedCwd`，覆盖起始 cwd；普通记录的 cwd（Bash 跟踪目录）故意忽略。AiTool `src/lib/sessions.js` 取**首个** cwd —— /cd 过的会话会归错项目。落点 sessions.js Claude 扫描处 + 头尾行读取窗口。
- **`c3ad9bb` 模型抓取 compatible-mode 候选**：`/apps/anthropic` 结尾的 base（阿里百炼/千问 Token Plan）没有 `/v1/models`，模型列表只在 `/compatible-mode/v1/models`。AiTool `src/lib/provider-switch/api.js:1380` 的候选列表缺这一条。
- **`c8f8567` MCP 面板显示名**：`provider-mcp-panel.jsx` 服务器行展示 `server.name`、自定义名时附注 id；删除确认同样用显示名。
- **`52652a0` 会话项目组头整行可点**（`w-full`）。
- **`e1821b5` Codex 配额窗口 used==0 隐藏倒计时**（占位 reset 时间不显示）—— 检查 AiTool usage-limits 的 codex 窗口行是否有同症状。
- 检查项：`29f8bef` 请求日志总数收缩时页码回收（AiTool `requests-tab.jsx` 是否保留越界页码）；`47ffdff` Unix 登录 shell PATH 合并（AiTool desktop 场景 spawn CLI 时）；`e5b0422` Keychain 按账户查找（AiTool `subscriptions.js:186/202` 已带 `-a` 账户参数，确认有无 service-only 兜底）。

### 4. Magpie 增量（P1-P2，按需）

115 提交 / 46 个 release，多数是 Magpie 自身 GUI、网关与插件生态。与 AiTool 整合面相关的：

- **WorkBuddy 适配器行为**（社区插件 `f6588420` 0.1.31：401 续期一次后重发、拒绝登录明确提示重新登录；`575f1e23` 0.1.30 拒绝语在助手消息中的改写）。AiTool `src/lib/proxy/extensions/workbuddy.js` 已有 refresh 与 "sign in again" 提示 —— 验证 401 中途重试一次的语义对齐即可。
- **模型规格统一定义**（`4a3e07f1` 一条规格同时定 window/output/vision/levels；`edff2f81` 仅保留再次提供的档位；`7aad6a50` 自定义供应商的全局窗口优先于他厂猜测；`f985d6bd` 未列出模型的 Max output 不阻塞保存）。对 AiTool provider-switch 的模型窗口/覆盖管理是可借鉴的方向，P2。
- **用量别名去重**（`ea9454d2`：同一模型的两个 ID 计一次，magpie model alias）。AiTool 代理别名场景下的模型统计有同类问题，属产品决策，P2。
- **redaction 确定性**（`50f52b54` 同文本遮蔽结果稳定以保缓存命中；`24359441` 转义后仍保持 JSON）—— AiTool privacy mode 可借鉴，低优先。
- **ZCode 订阅插件**（`zcode` 0.1.21–0.1.24：Start Plan 请求、gift plan 分桶命名、Claude Code 子代理 ToolSearchTool 映射）：经"已安装 Magpie"路径即可用，AiTool 无需自研；重度使用 ZCode 的话值得知晓。
- 其余（dsh/DeepSeek Harness 新 agent、Requests 折线图、时区展示、路由组 UI、Kimi 合作伙伴位等）：N/A。

### 5. EasyCLIProxyAPI：无需动作

4 个提交全部在 Tauri 后端（Claude Desktop 网关集成 `6197d0a`）、CI（miaomiao 预览线）与 core 8.0.38 pin。**前端页面零改动**，AiTool 六个代理 tab 无需对齐。Claude Desktop 是 AiTool 有意排除的 scope。core pin 直接跟随第 1 项升到 v8.0.41 即可（上游自身才 8.0.38，AiTool 领先是既有状态）。监控 `miaomiao` UI 改版线合入 main 的时机（当前领先 26 提交，未合入）。

## 大件评估

| 候选 | 来源 | 评估 |
| --- | --- | --- |
| **Kimi Code 全套管理** | cc-switch `e4873bc`/`7da2553`/`07265bc`/`cdd2190` 等（第 12 个受管应用） | `~/.kimi-code/config.toml` 多供应商（honors `KIMI_CODE_HOME`）、官方 OAuth 多账号（区域固定端点、`/me` 身份、slot 哈希命名）、配额、models.dev 拉模型、MCP/Skills/prompts、会话浏览与用量导入。AiTool 已有 Kimi **analytics**（`.kimi`/`.kimi-code` 会话），**零管理面**。工作量**大**；用 Kimi Code 订阅的话价值高，建议单独立项。 |
| Codex Ultrafast 计费 | TokenTracker `0dce343a` | 见第 2 项；中。 |
| 离线设备用量导出/导入 | TokenTracker `faf34096` | +1274 行、5 语言 i18n、三平台原生桥，面向多机离线聚合。个人 fork 收益低，不做；Node 侧校验逻辑自洽，未来有需求可单独移植。 |

## 不引入（本轮明确）

- cc-switch 赞助商预设（hao.ai `132ab9c`、BuyToken `069c7fa`、V-API sponsor `91d3ed1` 及 referral 调整 `e85ade7`/`717172b`）与 V-API 备用端点 `3494d0d`（AiTool 预设集已去赞助商化，无 V-API 预设）。
- cc-switch usage 页重构 `79ba798` 及列间距/DST/配色修复（`e53ca7e`/`50e091b`/`c6f8546`）—— AiTool 未移植 cc-switch usage 页，请求日志是 EasyCLIProxyAPI 交互移植；DST 日历日步进作为检查项保留。
- cc-switch 内置 proxy 修复（`7ecce7c` 加密 thinking、`2e1e297` Codex 会回头别名）—— AiTool 走 CLIProxyAPI 核心。
- cc-switch `91fc2fc` comp_hash 按工具协议分组（AiTool 不写 comp_hash）；`2fbd9c7` WSL 内启动 dashboard（AiTool 自有服务端）；`04d0ebf` open-file 软上限（Rust 侧）。
- EasyCLIProxyAPI `6197d0a` Claude Desktop 配置/8 通道路由 —— AiTool 有意排除 claude-desktop scope；若未来加入，该提交与其文档是完整参考实现。
- CLIProxyAPI Home 集群（`befcba23`/`e45f9426`）、全部翻译器保真修复（随 pin 升级自动获得）。
- TokenTracker CI Node22 隔离 `b8bd81c0`（AiTool CI 全 Node 24）、v1.4.8/v1.4.9 发布提交、Sentry 相关。
- Magpie 合作伙伴/README 赞助、GUI 动效、release notes 多语言等。

## 验证边界

本次评估读取本地克隆 diff、GitHub API（Magpie compare/releases）与 AiTool 源码对照；未运行 v8.0.41 二进制、未做隔离兼容检查、未改任何业务代码。升级 pin 后按第 1 项清单验证；sessions /cd 与 agy UA 修复各需带真实数据的回归测试。

## 来源

TokenTracker `git log 4cb82c70..origin/main`；cc-switch `git log 0a41250d..origin/main`；CLIProxyAPI `git log ce07d189..upstream/main`（v8.0.38 `0db19025`/v8.0.39 `ceb045a1`/v8.0.40 `d946c4fb`/v8.0.41 `8289ec4c`）；EasyCLIProxyAPI `git log 9fc0a33b..upstream/main`；Magpie [compare](https://github.com/yetone/magpie/compare/86254d40...main) 与 [releases](https://github.com/yetone/magpie/releases)（v0.1.1318→v0.1.1364）、[社区插件 compare](https://github.com/magpie-community/plugins/compare/7fdc07f...main)。
