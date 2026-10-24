# 上游更新实施记录 — 2026-10-24

实施[本次五上游评估](upstream-review-2026-10-24.md)（TokenTracker / cc-switch / EasyCLIProxyAPI / CLIProxyAPI / Magpie）中全部适用候选。沿用 `dev`；应用版本不变。评估中列为"不引入"的项目（赞助商预设、cc-switch usage 页、内置 proxy 修复、Claude Desktop、离线设备导出、Home 集群、Sentry）未做；**Kimi Code 全套管理按评估建议单独立项，本轮不含**；Magpie 的模型规格统一与用量别名去重为方向参考，未落地。

## 实施清单

- [x] CLIProxyAPI 核心 pin v8.0.37 → v8.0.41；隔离二进制下载（GitCode 镜像，Commit 8289ec4c 校验）+ `scripts/acceptance/proxy-core-smoke.cjs` 全过（四协议、23 次调用 23 条记录、usage 桶、clean EOF）。pin 变更不替换运行中的核心（本机安装版未动）。
- [x] Requests 详情展示服务层级：`normalizeRecord` 已透传 `effective_service_tier`/`response_service_tier`，详情区新增 Service tier 行（copy.csv + 五语言）。
- [x] serve 静态文件 mid-open abort FileHandle 泄漏修复（TokenTracker 56e21b4a 适配 AiTool 预压缩变体路径）：close 监听移到入口、每个 await 后检查 `clientGone`、`stream` 提升供监听器销毁；新增三个 abort 时序测试（基础 open / 可协商资源 open / 变体重开）。
- [x] agy 直连 Google 配额 UA 修复（cc-switch b5aa7fb）：`aitool (antigravity)` → `aitool (antigravity/cli/<版本>)`；`agy --version` 进程内探测一次（5s 超时），解析失败回退 1.4.6 —— 否则 Google 只回 Claude/GPT 档、不回 Gemini 档。
- [x] Claude 会话按最后 `/cd` 位置分组（cc-switch ea8bc2c）：读取 transcript 尾部 64KiB 内最后一条 `type:"relocated"` 的 `relocatedCwd` 覆盖起始 cwd；普通记录的 cwd 漂移不影响分组。
- [x] undici 8.11.2 → 8.12.2（CVE-2026-87018）。
- [x] 模型抓取候选补 `/compatible-mode/v1/models`（cc-switch c3ad9bb）：`/apps/anthropic` 结尾的 base（千问/百炼 Token Plan）404 后落到兼容模式路径。
- [x] Codex Ultrafast 6x 计费（TokenTracker 0dce343a）：service_tier `ultrafast` 与 Fast/priority 分离 —— `ULTRAFAST_SERVICE_TIERS`、parser `ultrafast_*` 11 列 + `ultrafast_usage_events`、rollout `addUltrafastUsage`/`SPEED_TIER_SUBSET_FIELDS`/`totalsKey` 追加 `|u:` 段、pricing `tierPremium` 重构、curated `gpt-6-astra`/`gpt-6.1-sol` `ultrafast_multiplier: 6`、session-analytics 字段保留与 SIDECAR_VERSION 27 → 28（一次 sidecar 全量重建）。AiTool 增量：`subtractTotals` 同步遍历合并字段集（上游遗漏，防重建残留）。
- [x] Haiku 5.5 fuzzy 条目（`haiku-5-5`/`haiku-5.5` → exact 费率）：exact 与 edge 镜像 10-11 已有，本次补 curated fuzzy 两条防 dated/dotted 变体落到 4.5 费率。
- [x] TokenGalaxy WebGL 运行时 fallback（TokenTracker 256ef46d，组件与上游改动前逐字节一致后整段替换）：`disposeGalaxy`/`failToStatic`/`webglcontextlost` → 静态模式 + 232 行运行时测试。
- [x] 小修包：MCP 删除确认优先显示名（面板本身已显示 server.name + id）；Codex 未使用窗口隐藏占位 reset 倒计时（e1821b5 同款保护，`used==0` 时置空 `reset_at`）；Requests 页码越界回收（29f8bef 同款，含测试）；`resolvedCliEnvironment` 合并全局安装目录集进子进程 PATH（47ffdff #8653 的无 spawn 等价实现，覆盖 `env node` shebang）；notify-debug-log 测试改为 `buildNotifyHandler` 直写 + 预置 throttle（88ms，原两次完整 init）；init-local-runtime-reinstall 三个用例 `timeout: 300_000`；sync 上传摘要三态消息（盘上有 token 未传运行时 → "handled by local server"）。
- [x] macOS Keychain service-only 回退（cc-switch e5b0422）**评估后不做**：AiTool 已有测试断言"选中条目缺失时不回退到无关的旧账户条目"（`test/subscriptions.test.js`），按账户查询是既有有意决策，实施中撤销。
- [x] WorkBuddy 401 renew-once（magpie-community plugins 0.1.31 语义）：请求中 401 在账户文件锁内续期一次并重发；并发下他方已续期则复用；无 refresh/过期仍明确 "sign in again"。含针对性测试。

## 会话组头整行可点（不适用）

cc-switch 52652a0 的 `w-full` 修复在 AiTool 的 `cli-session-list.jsx` 实现中已天然满足，未改动。

## 验证边界

- v8.0.41 冒烟为隔离验证：临时目录、loopback fixture，未触碰已安装核心、真实配置或用户队列。管理面 ETag 往返未单独复测（冒烟脚本覆盖管理引导与四协议端到端；源码级核对协议面零破坏）。
- interactions 协议（插件宿主）流式 token_breakdown 的费用高估修复（8289ec4c）在 AiTool 侧无需代码改动，属核心行为；本机未装 interactions 插件，未做升级前后对比。
- Ultrafast 语义以合成日志验证（parser → 队列 → pricing → session 范围视图全链断言 6x）；未在真实 gpt-6-astra/6.1-sol 订阅上复测。sidecar v28 首次分析会全量重扫。
- macOS 本地 `os.tmpdir()` 符号链接（`/var` vs `/private/var`）会使部分会话根钳制测试失败 —— 与本次改动无关的既有环境现象，本地验证用 realpath TMPDIR 规避，CI（Linux）不受影响。

## 来源

评估见 [upstream-review-2026-10-24.md](upstream-review-2026-10-24.md)。上游提交：TokenTracker `0dce343a`/`56e21b4a`/`256ef46d`/`5c10cac1`/`5447f31f`；cc-switch `b5aa7fb`/`ea8bc2c`/`c3ad9bb`/`e5b0422`/`e1821b5`/`29f8bef`/`47ffdff`/`52652a0`/`c8f8567`；CLIProxyAPI v8.0.38–v8.0.41（`8289ec4c` 等）；EasyCLIProxyAPI 无动作；magpie-community plugins workbuddy 0.1.31。
