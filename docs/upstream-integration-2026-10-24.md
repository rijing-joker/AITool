# 上游更新实施记录 — 2026-10-24

实施[本次五上游评估](upstream-review-2026-10-24.md)（TokenTracker / cc-switch / EasyCLIProxyAPI / CLIProxyAPI / Magpie）中全部适用候选。沿用 `dev`；应用版本不变。评估中列为"不引入"的项目（赞助商预设、cc-switch usage 页、内置 proxy 修复、Claude Desktop、离线设备导出、Home 集群、Sentry）未做；Magpie 的模型规格统一与用量别名去重为方向参考，未落地。**Kimi Code 全套管理原计划单独立项，应用户要求在本轮一并实现**（见下文专节）。

## Kimi Code 全套管理（cc-switch e4873bc / 7da2553 / 07265bc / cdd2190 移植）

第 11 个受管应用 `kimi`（MoonshotAI/kimi-code，`~/.kimi-code`，`KIMI_CODE_HOME` 覆盖）：

- **原生多供应商配置**（`src/lib/provider-switch/kimi.js`）：config.toml 的 `providers`/`models` 双表联动投影 —— 添加写节点不动 `default_model`；「设为默认」保留目标供应商已有模型否则选首个；模型别名全局唯一（跨供应商冲突拒绝）；删除拒绝正在使用（default/secondary_model 引用）的供应商；官方 OAuth 节点（type kimi + oauth.key）只归账号中心管理。与 cc-switch 的差异：TOML 全文档重序列化（同 Grok Build 先例），注释不保留；写入前备份。
- **官方 OAuth 多账号**（`kimi-accounts.js`）：设备码流程（区域固定 auth.kimi.com / auth.kimi.ai，不跨区回退）；首个登录占 Kimi 自己的默认槽位（`managed:kimi-code` / `credentials/kimi-code.json`），后续账号 `kimi-code-ccs-<sha256(region:userId)[:8]>` 槽位 + "Kimi Subscription <昵称>" 可读 ID；`/me` 身份缓存在 `~/.aitool/provider-switch/kimi-accounts.json`（0600，不进云同步）；同账号重登录原位覆盖；额度走 `/usages`（5h + 周窗）；刷新遵守 Kimi 跨进程协议（`oauth/<slot>.lock` 目录锁 5s 失效、锁内重读、拒绝时先采纳他进程轮换的 token 再写 tombstone；Windows 不刷新）；「使用此账号」只选模型；独立账号删除连模型/凭据/卡片（在用先切走），默认登录只"移出列表"（从不替 Kimi 退出）；删除独立账号时其服务（moonshot_search/fetch）改指默认登录。
- **凭据安全**：credentials 目录 0700、文件 0600；凭据路径钳制在 credentials 目录内（防路径穿越）；凭据写失败时 config 字节级回滚。
- **接线**：store/paths/presets（开放平台国内/海外 + 自定义，协议 select 字段）、api.js（save/switch/disconnect/delete/import-live/editor-view + `/kimi/accounts*` 路由）、`/switch` 空id 走 disconnect、plan-quota 补 Kimi Coding Plan（API Key 场景 `api.kimi.com|ai/coding` 前缀匹配，quota.js 凭据解析 kimi 行）、MCP（`~/.kimi-code/mcp.json`，stdio/HTTP + 原生 `transport:"sse"`）、Prompts（`AGENTS.md`）、Skills（`skills/`）、CLI 会话第 10 个只读来源（`sessions/<wd>/<id>/state.json` + `agents/main/wire.jsonl`：agent.switched 分支链只显示活动分支、committed 投影优先于 legacy 流、step.end↔messageId 关联解析真实模型、`env KIMI_CODE_HOME=… kimi --session <id>` 恢复命令）。
- **仪表盘**：Kimi Code 应用页 + 账号面板（区域选择、设备码展示、逐账号额度/使用/重登/删除）+ 供应商表单（协议 select + 模型 JSON 编辑器）；文案 24+9 键 ×6 语言；协议标识符键加入 locale 同文 allowlist。
- **测试**：`test/provider-switch-kimi.test.js` 13 例（引擎语义/官方保护/登录合并与回滚/双账号与重登/区域隔离/刷新轮换/额度/API 全流程/会话投影与分支/MCP 往返）。

依据：cc-switch `docs/kimi-code-integration-zh.md`（d8983bb 版）与 `kimi_config.rs` / `services/kimi_oauth/` / `session_manager/providers/kimi.rs` / `mcp/kimi.rs` / `coding_plan.rs`（query_kimi_at）。

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
