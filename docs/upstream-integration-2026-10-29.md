# 五上游整合实施 — 2026-10-29

依据 [10-29 评估](upstream-review-2026-10-29.md)，基线 `dev` = `d75f4c6`。全部适用于 AiTool 的候选已实施；应用版本不变，沿用本地优先、配置所有权、写前备份、冲突恢复和只读会话边界。

固定上游为 TokenTracker `f80ed15a`、cc-switch `9403960f`、EasyCLIProxyAPI `066ed455`、CLIProxyAPI `90c447d3`（v8.0.47）、Magpie `5143bf59` 及其社区插件 `6a86762e`。完整 SHA、来源提交和原始评估见上述评估文档；Magpie 本轮引用代码的许可证为 MIT，归属已写入 `THIRD_PARTY_NOTICES.md`。

## 实施顺序及完成项

### 第一批：核心、统计与协议兼容

- [x] CLIProxyAPI v8.0.47 安装基线、隔离兼容验收、显式手动模型刷新；管理请求声明 `accept-encoding: identity`。
- [x] Qoder/Qoder CN：零 token 免费调用保留活动，credits 取有效较大值；subagent 只计 token；异常时间戳不阻断来源；游标允许后续补 token 且重复同步不重复计活动。桌面额度增加有界倒序 `main.log` 扫描及新 bundle 发现，保留过期过滤与 CN CLI/add-on 分离。
- [x] Codex MCP 只过滤外来 `timeout` / `autoApprove`，保留 SSOT、Grok 和 Codex 原生秒级参数；不支持 SSE 的应用有明确提示。OpenCode 支持 v1/v2 双布局，同名 v2 优先，编辑跟随布局，移除清理两处。
- [x] Kimi 官方账号和 Coding Plan 共用新旧额度归一化：5h/7d/Month，新格式优先、非正 limit 不生成额度、不加总月度 code 子集；跨 UTC 偏移/跨日 fixture 验证。
- [x] WorkBuddy：5.9.3 请求头、历史 reasoning 转换、支持范围内的默认 effort、按账号隔离的 HMAC 会话/turn ID、无周期钱包余额；聊天 JSON 单次序列化后 gzip，首字节前 401 仅续期一次，Messages 保持明文原生通道。
- [x] TRAE CN 增加经典 `Trae CN` 路径，显式/优先路径不可读时保留诊断。Terra exact/fuzzy 与长上下文/Fast 计价同步到本地及五份 edge 镜像。
- [x] 可选云 account-view 超时后共享读取仍在后台完成，成功结果清除失败态；社区缓存按完整字段合并并保留可复用数据。云开关仍默认关闭。

### 第二批：受管应用与模型体验

- [x] DSH：元数据会话 sidecar（schema 30）、Sessions 来源筛选、只读正文，以及 provider/MCP/Skill/prompt/profile 和原生终端启动。分析数据不包含对话正文，正文读取继续验证根目录、revision 和重放完整性。
- [x] OMP provider-switch：原生 `models.yml` 文本补丁保留注释、flow map 和无关锚点；不确定的别名修改拒绝写入。命名 profile 路径与启动环境一致。
- [x] Standard/Fast/Ultra Fast 别名、后端校验、默认别名及编辑回读；Ultra Fast → Fast → Standard 保留 reasoning effort。
- [x] Codex 模型目录鼠标/键盘拖拽、可搜索子代理模型选择器；全局子代理开关、并发数、中断消息独立保存，使用原生锁、revision 和备份，不随 provider 的 model/effort 投影覆盖。
- [x] WorkBuddy API key 登录与 Free models only；免费目录来自实时目录和价格，转发时再次检查，不按名字推测免费。

### 第三批：账号与资源库

- [x] Claude 官方多账号：隔离原生 CLI 登录、官方卡绑定、默认账号迁移、原生账号接纳、独立额度、隔离启动、默认重认证、取消进程组、锁与恢复。共享 MCP/设置只镜像受管字段，保留各账号手写定制。
- [x] MCP Hub：独立可调用入口、带命名空间的工具、专用 Bearer、按需 stdio/HTTP/SSE 上游、并发复用、取消、空闲清理、工具过滤、原生配置投影与恢复。检查操作和工具调用分别实现。
- [x] 共享 Skill 显式移交/归还管理权、真实生效范围、校验副本和恢复记录；提交前重新读取完整 registry 行，外部修改保留。Skills 页面列出未完成操作并提供恢复入口。
- [x] 插件更新 UI 适用性审查完成：AiTool 的内置 adapter 随代码更新，已安装 Magpie 及其插件仍由 Magpie 管理；本项目没有自己拥有的可安装/更新插件清单，因此不新增虚构的单独/批量插件更新器。

### 第四批：界面、文档和验收

- [x] Sessions 可访问加载骨架和效率列；ZCode reset-card 按 5h/周分组折叠、数量/最早到期/倒计时条，过期卡与空组隐藏。
- [x] 新账号、Hub、Codex 全局设置及 Skill 恢复沿用当前设计系统、繁简中文和主题语义。修复弹窗拦截排序方向键，拖拽时 Escape 优先取消拖拽，下一次 Escape 才关闭弹窗。
- [x] Zen Free 保留已有 UA 修复，为指定目录模型应用 258624 context floor。上游环境目录校验服务于其自动 prompt 补写机制，不适用于本项目的转发 adapter，不引入指令注入。
- [x] 更新 `CLAUDE.md`、`PRODUCT.md`、架构、文档索引及归属；当前 provider-switch 管理 13 个应用、只读 CLI 正文支持 12 个来源。
- [x] 定向回归、Node 24 后端全量、dashboard 全量/typecheck/build、文案/locale/hardcode/guardrails 与隔离核心验收。浏览器交互证据见下文。

## 新能力的入口与恢复方式

### Claude 官方多账号

在 Provider switch → Claude 的账号面板添加账号、查看独立额度、设为默认或启动隔离会话；编辑官方 provider 卡时可绑定已保存账号。读取状态和额度不会更换默认登录，登录凭据仍由原生 CLI 存在隔离目录或 macOS Keychain，账号 registry 不存 token。

本地记录位于 `~/.aitool/provider-switch/claude-accounts/`：`accounts.json` 保存身份/槽位元数据，各 `<localId>/config/` 是隔离原生目录，`switch-journal.json` 记录未完成的默认迁移，`projection-backups/` 保存不会被普通备份轮转淘汰的配置副本。迁移先持有原生槽位锁，再校验源/目标指纹；发生外部编辑或锁冲突时停止并保留凭据和记录。账号面板的恢复动作仅按已校验 journal 恢复，不以猜测覆盖新登录。

### MCP Hub

在 Provider switch → MCP 显式启用聚合入口，再打开“连接配置”取得入口和专用密钥。Hub 仅在调用时连接上游，工具名包含服务器命名空间，并按原来的应用启用状态和禁用工具规则过滤。它不复用 dashboard 管理密钥；密钥显示需显式请求，状态读取不会启动服务器。

入口为 `http://127.0.0.1:<serve-port>/api/mcp/hub/<app|all>`，状态/认证和文件收据位于 `~/.aitool/provider-switch/mcp-hub.json`，原生配置副本位于同目录 `mcp-hub-recovery/`。启用时将受管 MCP 项转为单个入口；关闭时恢复原文件并重新投影最新 SSOT 和工具规则。每个文件独立核对指纹，部分恢复失败保留记录并在界面显示恢复动作；外部修改不会被强行覆盖。

DSH 的 Hub 转换和恢复沿用原生 YAML plugin 编辑器，保持 provider 配置及外部插件的内容和注释；不会向 `cordis.patch.yml` 写入 TOML 表。

### 共享 Skill 管理权

原来仍位于 `~/.agents/skills` 的 Skill 会被部分客户端全局发现，应用投影开关无法阻止这条发现路径。Skills 页面明确显示此范围；只有显式“移交”后才搬入 `~/.tokentracker/skills/managed/`，各应用的启用/禁用才完全由受管投影表达。“归还”将当前内容交回共享目录。

每次操作先创建校验副本和 manifest，位于 `~/.tokentracker/skills/handover/<uuid>/`；有外部改动、路径重定向、损坏 registry 或写入中断时保留内容/记录。页面列出未完成移交/归还，可按记录恢复。恢复会先检查所有目标和 registry，保留操作之后的用户编辑。

移交 manifest 记录每个新投影的身份：链接核对 inode、创建后的变更时间和目标，复制目录额外核对内容指纹。Provider Switch 根据当前 registry 和 manifest 识别这些投影，使移交后的停用真正移除受管条目，同时保留用户替换的链接及编辑过的副本。

### OMP、DSH 与 Codex 全局配置

OMP 使用解析出的 agent 目录：默认沿用现有环境路径，命名 profile 为 `<OMP_HOME 或配置根>/profiles/<name>/agent/`，管理 `models.yml`、`mcp.json`、`AGENTS.md` 和 Skill；终端启动传递相同 `PI_CODING_AGENT_DIR`。DSH 使用 `<DSH_HOME 或 ~/.dsh>/profiles/web/cordis.patch.yml`，凭据写入原生 v1 `.credentials.yaml` 的 refs/records，配置只引用 key；移除时只删除值仍匹配的 AiTool 自有 ref。两者都纳入现有 profile 预检/备份/恢复与工具过滤。

Codex “全局子代理设置”直接管理原生 `config.toml` 的用户开关/限制；provider 编辑中的默认子代理 model/effort 是另一个所有权范围。自动保存携带读取 revision，冲突保留草稿并提供重新读取动作，缺失 revision 拒绝写入。

代理 Settings 的手动模型刷新使用认证 `POST /api/proxy/models/refresh`，汇总核心两处刷新结果；旧核心不支持和部分失败均返回能力/来源状态，不以空响应冒充成功。改变 `core-version.txt` 只影响后续安装，不替换本机已安装核心。

## 验证证据与边界

开发与测试使用 Node 24.22.0；测试原生配置、账号和 Skill 时隔离 HOME/CODEX_HOME，不使用真实登录。提交前后端全量 4,602 项：4,590 通过、12 跳过、0 失败，包含 Ultra Fast 回读及本次审查修复的回归测试。重点覆盖 Qoder 重复同步/补 token、原生配置所有权、Claude 锁/迁移恢复、Hub 真实本地 stdio/HTTP 生命周期和 DSH YAML 转换/恢复、Shared Skill 中断、移交后停用及外部链接/副本编辑保留、DSH 路径/revision 校验、Kimi 新旧额度及 WorkBuddy 传输与认证。

Dashboard 全量 159 个文件、1,207 项全部通过，TypeScript 检查和生产构建通过；文案注册、locale 覆盖、UI hardcode、架构 guardrails 均通过，Impeccable 对本轮修改界面的扫描无发现。构建仍有原有的大 chunk 和浏览器 crypto 模块提示。目录排序回归验证弹窗内方向键可到达 sensor，Escape 取消后不会关闭弹窗；ZCode 固定时钟验证 ISO 到期按小时倒计时及剩余生命周期同步更新。

提交前并行执行各项验证时，Dashboard 的排行榜冷启动错误测试首次触发 5 秒超时；该文件单独复跑 16 项通过，随后不与后端测试及构建并行的 Dashboard 全量复跑 1,207 项全部通过。

浏览器使用实际 `dashboard/dist`，所有 API 和外部请求截获为合成数据，不启动真实 AiTool 服务。验收矩阵为 1440px 浅色简中、390px 深色简中、390px 浅色繁中，页面无未捕获异常、各路线无外层横向溢出。验证 Claude 账号布局、Codex 自动保存/409 冲突/重新读取、Hub 启用/显式连接配置/关闭、DSH 会话及加载骨架、ZCode 折叠/倒计时/空组隐藏、Skill 恢复动作；桌面和手机简中另验证真实键盘/鼠标排序、取消和保存后保留行参数。截图复核发现的弹窗事件和倒计时时间单位问题均已修复。

可复现脚本：[upstream-ui-20261029.mjs](../scripts/acceptance/upstream-ui-20261029.mjs)。先构建 dashboard，再运行：

```sh
npm run dashboard:build
node scripts/acceptance/upstream-ui-20261029.mjs
```

可通过 `AITOOL_CHROMIUM_EXECUTABLE` 指定已有 Chromium，`AITOOL_UI_EVIDENCE_DIR` 指定截图/`evidence.json` 输出目录；默认输出到独立临时目录。本次浏览器证据保存在 `/tmp/aitool-ui-1029-final/`。提交前后端日志为 `/tmp/aitool-fix-review-backend.log`，Dashboard 全量复跑日志为 `/tmp/aitool-fix-review-dashboard-rerun.log`，定向别名日志为 `/tmp/aitool-ultrafast-roundtrip.log`，核心验收日志为 `/tmp/aitool-core-8047-final-smoke.log`。

核心使用独立临时目录的 v8.0.47 发布二进制，归档 SHA256 为 `2b5111dc6a0dfe0d607457787f794330d1b477bc9daa6337c26b0cd032a7827e`。`scripts/acceptance/proxy-core-smoke.cjs` 验证 Chat/Claude/Responses/Gemini 普通、流式和工具往返、RESP usage、重启连续性、ETag 冲突、gzip JSON/SSE 和取消。26 请求对应 26 唯一记录，客户端密钥不进入记录，取消关闭上游并记为 499。

仍存在上游边界：合成的“无完整结束标记但连接正常 EOF”场景中，Chat/Gemini 记录仍为 HTTP 200/未失败；Claude/Responses 可将记录标为 502，但已经发出的流式 HTTP 200 无法撤回。本轮没有修改外部 Go 核心去伪造统一行为。

Terra 官方价格页本次返回 403，价格按固定 TokenTracker 快照作为估算来源，不声称完成官方实时复核，不推导未公布的 Ultra Fast 费率。五份 edge 仅更新可审阅的本地镜像，未部署共享云服务。

尚未进行真实 WorkBuddy/Claude 账号调用、macOS Keychain/Windows 原生 CLI 的现场验收、安装版 Magpie 部署或本机核心替换；这些运行环境结果不能由合成与本地模拟测试代替。赞助/SEO/发布支付、整套替代网关、Claude Desktop 专属改动和自动指令改写仍按评估排除。
