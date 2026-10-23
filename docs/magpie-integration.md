# Magpie 能力整合：使用与验证

2026-10-22。本轮按[实施计划](./magpie-implementation-plan.md)完成配置管理增量和可选接入层。架构继续使用 Node 管理层、React 仪表盘及外部 CLIProxyAPI；不附带或启动 Magpie，不安装任意社区插件。源码依据和固定提交见[调研](./magpie-integration-research.md)。

## 入口

| 入口 | 可用行为 |
| --- | --- |
| 供应商配置 → MCP | 显式连接检查、工具分页、检查取消、单工具禁用、跨客户端环境变量引用 |
| 供应商配置 → 各客户端 | 最近成功投影与当前文件的生效诊断；显式无凭证地址检查；修复预览与修订核对 |
| 供应商配置 → 配置方案 | 明确选择多个客户端保存/应用 provider、MCP、技能和提示词；应用前检查及分项结果 |
| AI 代理 → 访问密钥 → 连接桌面客户端 | WorkBuddy 国内/国际模型文件及 Zed JSONC 模型组；模型发现、选定模型、恢复 |
| AI 代理 → API 接入 → 可选模型来源 | 已安装 Magpie 的发现/选择；独立 WorkBuddy 国内/国际订阅登录、目录、额度和受管上游 |
| AI 代理 → 访问密钥 → 搜索与视觉工具 | 显式 `web_search`/`analyze_image` MCP；本地实现或已连接 Magpie；连接所选客户端 |
| 供应商配置 → 技能 → 具名子代理与项目分发 | 原生角色文件；选定项目的技能副本与项目 MCP；先预览后应用 |
| AI 代理 → 访问密钥 → 高级路由 | `aitool/auto`；顺序规则、WorkBuddy 已知额度排序、可选意图分类或 Magpie 路由组；本地路由事件 |

新增能力默认关闭，打开页面不启动 MCP 程序、不发推理请求、不登录或刷新订阅账号。发现、可达性、登录、额度和写配置均由显式本地操作触发。已启用接入层随代理启动/停止。

## 配置和 MCP

检查执行 `initialize → notifications/initialized → tools/list`，不调用工具。stdio/HTTP/SSE 均有时限、数据上限与取消；最多三个检查并行。结果只存在内存，10 分钟失效，配置和引用环境值变化会使缓存失效。

单工具过滤支持 Codex、Gemini、Hermes、Claude、OpenCode。其他客户端不伪造生效。仅移除仍匹配 AiTool 回执的过滤规则，保留用户规则。SSOT 使用 `${NAME}`；投影为客户端原生引用语法，不支持的字段拒绝写入字面占位符。

诊断只根据受管字段的摘要和文件比较判断，不从“近期没请求”猜测绕过代理。修复预览复用真正的供应商投影；本地差异值可能含凭证，默认隐藏。修复与组合方案不是跨文件原子事务，每个应用/文件有结果与恢复副本。

## 桌面客户端与订阅

WorkBuddy **客户端连接**与**订阅上游**是两个独立方向：前者让 WorkBuddy 使用 AiTool 的模型，后者让其他客户端通过 AiTool 使用 WorkBuddy 订阅。

客户端配置：国内版 `~/.workbuddy/models.json`，国际版 `~/.workbuddy-ai/models.json`；保留已有模型和用户字段。Zed 只修改 `language_models.openai_compatible.aitool` 与所选默认模型，保留 JSONC 注释。密钥通过 Linux secret-tool、macOS Keychain、Windows Credential Manager 写入原生存储；不会落入 Zed settings。恢复会保留原生凭证条目，避免删掉仍可能使用的密钥。路径覆盖：`WORKBUDDY_CONFIG_DIR`（国内版绝对目录）、`AITOOL_ZED_CONFIG_DIR`。

WorkBuddy 订阅可以显式浏览器登录或复用可读桌面 access token。浏览器登录/刷新状态以 0600 保存；桌面方式只保存来源指针，每次使用重新读 token，绝不消费桌面的旋转 refresh token。桌面登录加密或即将过期时要求在原应用刷新或重新浏览器登录。推理保留系统指令与消息角色，不采用插件的身份替换、system→user 降级重试；工具名不兼容时明确拒绝。模型来自实时 CLI 目录，额度未知就显示未知。

WorkBuddy 上游请求统一启用 SSE 和流尾 usage；客户端非流式请求聚合为标准 Chat Completions JSON，保留文本、reasoning、工具参数及真实缓存用量，不估算缺失用量。错误流或缺失完成标记/finish reason 返回失败。非流式聚合上限 16 MiB，沿用扩展服务的取消与超时。

## Magpie 接入

先由用户安装、配置并启动 Magpie。默认只读配置目录 `~/.config/magpie`，遵循 `XDG_CONFIG_HOME`，可用 `AITOOL_MAGPIE_CONFIG_DIR` 覆盖。发现验证 `/api/hello` 和 `/v1/models`；完整保留 `provider/model`、`group/<id>`。配置变化后必须重新发现。

受管组使用强 ETag 和 `If-Match`；只改 `aitool-*` 组，外部修改会阻止覆盖或停用。停用需要核心管理 API 可达；若核心停止，先启动核心再停用。故障时保留回执以辨识不确定提交，不用离线 YAML 猜测当前配置。

为防止 hostname/interface 别名回环，Magpie provider 不能使用 AiTool 核心、扩展监听器或 Magpie 自己的端口，即使地址看起来是远端；远端服务需选不同端口。请求通过 Chat Completions 上游，其他客户端协议由核心转换。Responses 续接、压缩、工具搜索等原生扩展以及原客户端/session 归属不保证无损。

## 工具与路由计量

本地视觉和可选搜索摘要通过核心请求，出现在原请求记录。Tavily 搜索使用所选环境变量（默认 `TAVILY_API_KEY`），搜索次数单独统计，供应商另行收费。图片支持 PNG/JPEG/GIF/WebP data URL 或允许目录内的绝对路径，上限 6 MiB，拒绝远程 URL。MCP 有独立密钥，浏览器 Origin 和无凭证请求被拒绝；与推理共享最多 12 个并发槽并支持关闭取消。

Magpie 工具直接调用其 MCP，额外费用不进入 AiTool 核心统计。计数只保存名称及成功/失败数量，不保存查询、结果或图片。

本地路由按规则顺序选择具体模型；第一个模型为默认。额度排序仅支持 WorkBuddy credits 且所有候选额度已知；未知保留默认。跨模型重试、更多额度策略交给 Magpie group，本地不擅自实现核心未支持的策略。意图分类默认关闭，开启后将最后一条用户文本的有限片段发给选定分类模型，这属于额外推理调用。

分类和服务请求分别由核心记录；外层 `aitool/auto` 响应去除 usage，防止重复入账，因此客户端不会收到该外层 usage。外层仍是一条零 Token 分发记录。路由每次检查当前别名是否指回适配器/核心。路由使用管理员选定的本地客户端密钥；能访问 `aitool/auto` 的调用者可以使用该路由定义的候选模型，部署时把 route 本身作为授予能力。

事件只存 requested/selected、规则、分类调用状态与结果状态，最多 200 条；不保存任务或回复。Magpie 事件显式获取，只保留 AiTool 路由的模型/尝试/用量数值等元数据，不把 Magpie 内部重试/分类用量再加进核心账本。价格未知不能按路由别名猜。

## 分发与恢复

角色：Claude、Codex、Gemini、OpenCode、Grok Build 原生文件；Claude 可设置角色 skills/MCP，其余继承客户端。文件格式依据上游固定快照，客户端实际发现/实验开关仍取决于安装版本。

项目 MCP：Claude `.mcp.json`、Gemini `.gemini/settings.json`、OpenCode `opencode.json`；保留无关字段/注释。同名用户 entry 不覆盖。暂不在项目 scope 投影单工具限制，应继续用全局 MCP。项目技能：Claude `.claude/skills`，其他支持项共享 `.agents/skills`；复制上限 16 MiB/500 文件，拒绝源 symlink、特殊文件及危险名称。受管 `.gitignore` block 保留用户行，防止凭证与本地配置意外进入提交。

技能副本保留源文件的执行位，其余权限使用 0600；配置与备份始终使用 0600。预览修订包含源执行位和目标权限，恢复 manifest 记录目标原权限，避免恢复脚本时丢失执行能力。

先清空项目 MCP 选择并应用，再移除客户端选择。后者释放已清空 MCP 配置的归属，保留用户整个配置文件。所有目标按文件 hash 和预览修订核对，用户修改不覆盖；部分失败保留 pending 回执并列出未执行项。

恢复目录：`~/.aitool/provider-switch/profile-recovery/<id>/` 与 `distribution-backups/<id>/`，`manifest.json` 记录原目标、原存在状态、备份文件及应用结果。组合方案包括配置、SSOT、技能链接身份及完整技能目录副本；分发包括每个修改文件的备份。**没有自动恢复按钮**：停止客户端，核对现文件，按清单恢复原已存在文件；原不存在项仅在仍匹配受管内容时删除。不要整目录覆盖或删除用户后续修改。备份含本地密钥，权限 0600。

## 验证范围

- 后端新功能、归属漂移、分页、取消、环境引用、预览失效、恢复及授权边界使用临时 HOME 与合成服务测试。
- 整个仪表盘 1,189 项通过、后端 4,390 通过/12 跳过；前端交互专项 23 项通过；1440/390、明/暗、中文内容/空态/预览/MCP 工具界面渲染，无页面错误及横向溢出；Impeccable 扫描无发现；独立复核 `ship` 限于已发现的复选框配色和手机操作区域捕获两项，均解决。
- CLIProxyAPI **v8.0.37**（固定版本）及 **v8.0.35** 真核心 + 合成 OpenAI 上游：普通/流式请求、强 ETag 上游保存和停用、分类独立计量、缓存 60/输入 100/输出 10/reasoning 5 保留、外层零 Token。v8.0.37 发布包 SHA-256 `5fabb7ea9503f823e3a97fef613382422443585fe2b20e5de2bb43f41f90debc` 校验通过，临时提取运行，未替换用户二进制。
- 尚未登录真实订阅、运行完整 Magpie、修改真实 WorkBuddy/Zed 或验证三平台钥匙串。没有运行上游完整测试套件。

适配代码为 CommonJS，精确新增依赖 `jsonc-parser@3.3.1`。Magpie/WorkBuddy MIT 许可随适配代码保存于 `src/lib/proxy/extensions/LICENSE.*`。本轮不改版本、不发布、不自动上传或保存代理正文。
