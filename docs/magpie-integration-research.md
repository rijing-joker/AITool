# Magpie 调研与 AiTool 整合建议

调研日期：2026-10-22（北京时间）。结论基于固定提交的 README、子系统文档和源码审阅，以及 WorkBuddy 插件的五项离线合成检查。没有安装或运行 Magpie，没有登录真实订阅，也没有验证真实推理或 AiTool → Magpie 的端到端链路。

实施后的范围、入口和验收见[实施结果](./magpie-implementation-plan.md)与[使用说明](./magpie-integration.md)；下文保留调研时的评估基线。

## 结论

[yetone/magpie](https://github.com/yetone/magpie) 与 AiTool 高度重合，都是把多客户端、多模型、订阅账号和用量管理收进本地应用。**值得移植的是配置管理的增量、客户端适配器和部分订阅实现；先进路由和能力补全可以先通过可选上游试用。**

优先推荐：

1. **MCP 实际连通性检查、工具列表和单工具开关**，让“已配置”进一步变成“可用”。
2. **配置生效诊断**，区分配置被改、环境覆盖、地址不可达和运行中客户端尚未刷新。
3. **跨应用方案**，在已有单应用 Profile 上增加明确选定多个应用的保存/应用。
4. **更广的客户端适配**，优先 WorkBuddy、Zed，再按需求补 Droid、Kimi Code、Cursor 等。
5. **可选 Magpie 上游**，沿用 CLIProxyAPI 获取它的路由组和订阅插件；满足实际需求后再移植。

不建议整仓合并或替换 CLIProxyAPI。AiTool 已有的备份、配置编辑、MCP/技能/提示词、models.dev、请求记录、轮询和会话粘性应继续作为基础。

## 审阅基线

| 项目 | 固定快照 |
| --- | --- |
| Magpie | [`86254d4049cb6be4a2ccdab02edf0bd59860c603`](https://github.com/yetone/magpie/tree/86254d4049cb6be4a2ccdab02edf0bd59860c603)，提交时间 2026-10-22 16:27:54（北京时间） |
| 最新 release（查询时） | [`v0.1.1318`](https://github.com/yetone/magpie/releases/tag/v0.1.1318)，发布时间 2026-10-22 06:57:25（北京时间）；本次源码审阅以 main 固定提交为准，不将其视为 release 的实现 |
| 活跃度 | GitHub API 查询时约 1.92 万 stars；创建于 2026-09-23，仍在频繁更新 |
| 技术栈 | Go 1.26.8；Wails v3 GUI、Web、Bubble Tea TUI、CLI；provider 插件由 Bun 子进程运行，网关 JS 中间件/agent 插件用 moejs |
| 许可证 | [MIT](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/LICENSE)，Copyright (c) 2026 yetone |
| 社区插件 | [`magpie-community/plugins@7fdc07f15097ad06d8d03076b4f653ab42c687f9`](https://github.com/magpie-community/plugins/tree/7fdc07f15097ad06d8d03076b4f653ab42c687f9)，仓库 MIT；复用时仍需核对所选包及依赖许可 |
| WorkBuddy 插件 | `@magpie-community/opencode-workbuddy-auth`，该快照 package version `0.1.29`，ESM，单文件实现 |
| AiTool | 当前工作区；`core-version.txt` 为 `v8.0.37`；项目指导以 `CLAUDE.md` 为准 |

Git clone 和 codeload 未成功，改用固定提交的 GitHub tree/blob 与 raw 文件读取。Magpie 的 48 个文件、社区插件的 5 个文件均按 Git blob SHA-1 校验通过。没有运行上游完整测试套件。

## 它的结构，以及我们已有的部分

Magpie 把请求面、配置面和资料库都放在 Go 应用里：

```text
Agent 的原生配置 ← internal/agent 的字段投影、stash、applied
          ↓
Magpie gateway :3425
          ↓ 路由组 / 账号与额度 / 协议转换 / 可选中间件
API key / 原生订阅桥 / Bun provider 插件 / 本地模型

internal/library → 各 Agent 的 MCP、指令、技能、hooks、子代理文件
internal/usage   → 本地账本、额度、路由解释与会话投影
```

AiTool 则由 Node 管配置与管理 API、React 管界面、外部 CLIProxyAPI 管推理。直接搬 Magpie 的 gateway 会产生第二套协议转换、路由、认证和账本，需要同时维护 Go/Wails/Bun 与现有 Node/React/桌面壳。

| 能力 | AiTool 当前情况 | Magpie 的有效增量 |
| --- | --- | --- |
| 兼容协议、代理核心管理 | 已有 CLIProxyAPI 与管理面 | 多数重合；不要再实现一遍 Chat/Messages/Responses 转换 |
| Provider 最小投影、备份、编辑冲突 | 已有 `targets.js`、`editor.js`、备份和环境冲突提示 | 增加配置生效诊断、断开连接预览、更多客户端 |
| MCP、指令、技能 | 已有统一列表和原生投影；另有 `skills-manager.js` 的发现/安装/更新 | MCP 健康检查、单工具开关、统一环境变量引用、项目级分发 |
| Profile | 已有 `profiles.js`，保存/应用入口以单应用为单位 | 全部或选定多个应用的组合方案；不是从零新增 Profile |
| 子代理 | 已有 Codex 默认子代理模型/推理参数，保留用户自定义 roles | 具名子代理定义库，跨客户端生成原生角色文件 |
| 故障切换 | 核心已有重试、轮询/优先填充和会话粘性；配置层还有默认关闭的 `failover.js` | 跨模型路由组、额度感知、权重、按任务分类及逐次决策解释 |
| 用量和会话 | 已有多来源统计、只读会话、缓存/推理计价、首 token 时间和恢复命令 | 显式 session/父子代理归属、requested/served/attempt 的关系、原生终端打开 |
| 隐私 | 展示账号遮罩；统计不收集正文，cloud sync opt-in | 请求发送前的秘密/个人信息替换及回复恢复，属于另一种能力 |

对照依据：`src/lib/provider-switch/{store,targets,editor,mcp,skills,profiles,universal,failover,agy}.js`、`src/lib/proxy/{usage-record,usage-bridge,pricing,alias-config}.js`、`dashboard/src/pages/{settings-tab,cli-session-reader,ProviderSwitchPage}.jsx`。

## 可以直接融入的配置能力

### 1. MCP 检查、单工具开关、变量引用

Magpie 的 [`mcp_check.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/library/mcp_check.go) 真正执行 MCP 的 `initialize → notifications/initialized → tools/list`：stdio 启动进程，远程服务走 HTTP/SSE，记录失败阶段、授权状态、工具列表和检查时间。结果按配置/授权状态缓存，修改后失效，检查并发有上限。

AiTool 建议在现有 MCP 页增设显式“检查”和工具展开，后端新增独立 checker，由授权本地 mutation 路径触发。启动 stdio 服务是执行用户配置的程序，不应在打开页面时自动启动所有服务。区分缺程序、缺环境变量、授权、超时和协议失败；进程取消后清理，检查使用独立工作目录。

工具禁用不是每个客户端同一个字段。Magpie 的 [`mcp_tools_off.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/library/mcp_tools_off.go) 及[资料库文档](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/docs/subsystems/library.md#constraints-and-failure-behavior) 给出映射：

| AiTool 已支持的客户端 | 单工具禁用的原生方式 |
| --- | --- |
| Codex | MCP server 的 `disabled_tools` |
| Gemini CLI | server 的 `excludeTools` |
| Hermes | server 的 `tools.exclude` |
| Claude Code | `settings.json` 的 `permissions.deny`，规则 `mcp__<server>__<tool>` |
| OpenCode | 顶层 `tools` 中 `<server>_<tool>: false` |

其他客户端必须展示“不支持单工具开关”，不能假装已生效。只收回 AiTool 写入且仍未被用户修改的规则，保留原有 deny/过滤列表。原生格式/命名仍需按实施时客户端版本复核。

另一个实用增量是 [`envref.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/library/envref.go)：统一存 `${TOKEN}`，投影为 OpenCode 的 `{env:TOKEN}`、Codex 的 `bearer_token_env_var` / `env_http_headers` / `env_vars` 等。AiTool 目前能透传部分原生字段，但尚无统一的跨应用转换；不支持引用的客户端要明确拒绝，不能写入字面占位符或自动展开为明文。

### 2. 配置生效诊断

[`applied.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/agent/applied.go) 分别报告 `unwired`、`replaced`、`bypassed`、`unreachable`、`proxied`，并提供重新应用或接受现状。这个能力比“再加几个 Provider 预设”更能解决日常问题。

AiTool 已有环境冲突提示和 Codex daemon 刷新状态，可进一步增加：

- 当前 live 配置与最近成功投影的差异，以及变更来源是否已知。
- 地址是否可达、运行中客户端是否需要重启。
- 修复前调用现有投影器生成真实 diff，不另写一套预览逻辑。

先做配置和可达性诊断。**没有可靠请求归属时，“最近没看到请求”不能判定绕过代理**；现在配置层 failover 对请求的匹配还是启发式，更不能将其视为准确的逐请求路由。

### 3. 跨应用方案、项目分发和具名子代理

[`internal/profile/profile.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/profile/profile.go) 保存检测到的各 Agent 字段、模型短名单和资料库开关。可以做“日常 / 省钱 / 强推理”方案，同步切换 Claude、Codex、Gemini 的 provider/model、MCP、技能和提示词。

沿用 AiTool 的 `profiles.json` 和应用函数，新增明确选择的应用集合。继续区分 `null`（未捕获，不动）与空列表（捕获了关闭状态）；应用前检查全部引用和文件修订，输出每个应用结果。Magpie 自己也是逐步写入、遇错停止，**跨文件原子事务不是已有保证**；AiTool 应有可恢复备份，不能承诺一次写入绝不部分成功。

[`projects.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/library/projects.go) / [`project_mcp.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/library/project_mcp.go) 可供后续把技能和 MCP 分发到用户选定项目。需要独立 scope 和写入凭据，不把现有全局开关悄悄改成项目开关。

[`subagents.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/library/subagents.go) 可参考为具名 `reviewer`、`tester` 等定义生成 Claude Markdown、Codex TOML、OpenCode/Gemini Markdown。它通过文件 hash 识别自己写的内容；用户同名文件不覆盖。AiTool 已有的“默认子代理模型”继续独立。各客户端支持的工具/技能限制不同，实施前还要验证目标版本是否实际发现角色文件。

### 4. 扩展客户端：优先 WorkBuddy 与 Zed

Magpie 的 `internal/agent` 适配范围比 AiTool 配置层当前十个应用更广，且有原生路径、保留用户字段、断开恢复和模型目录刷新等处理。

- **WorkBuddy 作为客户端**：[`workbuddy.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/agent/workbuddy.go) 将模型列表投影到 `~/.workbuddy/models.json`，国际版单独使用 `~/.workbuddy-ai`；模型在 WorkBuddy 自己的 picker 选择。这条路径是“WorkBuddy 使用 AiTool 的模型”，不依赖 WorkBuddy 订阅反代。
- **Zed**：[`zed.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/agent/zed.go) 可参考原生模型配置和 JSONC 最小编辑，MCP 投影到 `context_servers`。需要保留注释及用户/扩展已有项目。
- **Droid、Kimi Code、Cursor 等**：按用户需求逐个引入。不要把“analytics 已支持该工具”误认为“配置切换已支持”。

## 可通过上游试用的代理能力

### 5. Magpie 作为可选上游

Magpie 源码确有 `GET /api/hello` 的 `{name:"magpie",version}`、`GET /v1/models` 和 Chat/Messages/Responses/Gemini 路由，见 [`gateway.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gateway/gateway.go)。默认端口 `3425`，用户可修改；读取设置仅用于发现，不写 Magpie 的文件。

推荐试验路径：

```text
AI 客户端 → AiTool / CLIProxyAPI :8318
          → 用户选择的 Magpie :3425
          → Magpie 的 API / 订阅 / 路由组 / 插件

CLIProxyAPI → 现有 RESP usage bridge → AiTool 请求记录与 cliproxy 桶
```

这是可行性方案，尚未跑通验证。可复用 `src/lib/proxy/opencode-free/index.js` 的受管 upstream group、冲突校验和 ETag 流程；用户已安装的 Magpie 由用户管理生命周期，不强制附带 Go/Wails/Bun。

首版选择固定模型和已验证的协议。保留完整 `provider/model` 或 `group/<id>` 路由 ID。Chat-compatible upstream 可以起步，但 Responses 原生项目、工具搜索、压缩/续接等不能凭“支持标准 API”推断无损。

接入时有四个实际难点：

1. **路由循环**：Magpie 若已有 Provider 指回 AiTool，会形成 `AiTool → Magpie → AiTool`。启用前检查已知配置，并为受控请求链提供跳数/循环保护。
2. **客户端和 session 归属**：中间核心可能改写 User-Agent、凭证和头；`magpie-aitool` 能把整组归到 AiTool，但不能自动保留 Claude/Codex 原客户端或任务身份。按 session/agent 的路由要专门验证传递。
3. **用量与真实模型**：核心可统计外层请求，但 `group/daily` 不足以定价真实模型；Magpie 的分类、搜索、视觉和失败重试可能额外付费，外层 usage 不一定包含它们。先显示未知价格/覆盖范围；不能按路由别名猜模型或把所有账本再加一遍。
4. **内部连接设置**：Magpie 的 loopback 接口与 AiTool 随机 key 机制不同；内部 upstream 必须明确直连，使用独立标识，不能复用 AiTool 管理密钥。账号/凭证仍由各自应用管理。

### 6. 路由组与可解释路由

Magpie 的 [`group.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/group.go)、[`strategies.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/routes/strategies.go)、[`ruleparse.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/ruleparse.go) 支持：

- 跨 provider/model 的虚拟模型，可嵌套和按目录模式动态加入成员。
- `smart`、`order`、`rotate`、`usage`、`pace`、`weight`、`free`；`smart` 关注额度重置时间，`pace` 关注重置前每小时剩余额度。
- Agent、目录、上下文长度、图片、时间及 intent 等规则。
- 会话粘性、首 token 等待和失败回退。

**这些不是给现有设置页加几个 option 就能实现。** AiTool 界面目前明确暴露的是核心 `round-robin` / `fill-first`；不能未经核心能力核对就写 `routing.strategy=smart`。可选 Magpie 上游能先提供虚拟模型；原生实现则需要核心支持或独立请求适配层，不能交给只看历史失败率的 provider-switch monitor。

[`classify.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gateway/classify.go) 还会把当前用户消息和前一轮的部分上下文发给选定分类模型，默认有 8s 超时、10 分钟缓存和失败退避；分类也记为自己的推理调用。应先做无需模型的规则，再考虑显式开启的 intent 分类，并计入额外费用与延迟。

[`trace.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gateway/trace.go) 在决策发生时记录候选、排序依据、等待、回退和真实服务模型。AiTool 可以增强请求详情，但必须来自真实决策事件：若当前核心未发布 attempt/route 信息，不能用最终 record 反推出“为什么选了这个账号”。

### 7. 搜索与视觉能力补全

Magpie 既能拦截模型请求补搜索/看图，也提供独立 MCP：

- [`search_mcp.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gateway/search_mcp.go)：`/mcp/magpie/web-search`，`web_search` 与 `web_fetch`。
- [`vision_mcp.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/gateway/vision_mcp.go)：`/mcp/magpie/vision`，`analyze_image`。

AiTool 更适合先做显式 MCP 工具，通过现有 MCP 投影给各客户端；视觉模型调用仍经 CLIProxyAPI，从而进入现有用量记录。搜索 API 按自己的次数/credits 记录。可先把已安装 Magpie 的上述 MCP 地址加入预设，也可后续做独立 Node MCP 服务。

自动把图片替成文字描述会损失信息，自动注入搜索会改变回答来源；首版不启用透明补全。文件型图片输入要有明确可读范围；Magpie 的实现按本地 caller 决定能否读绝对路径，不能直接作为 AiTool 的路径边界。

## 新订阅来源：重点看社区插件

Magpie 当前已经把 WorkBuddy、Cursor、Qoder、Devin、Factory、Grok、Zed、Kiro、ZCode、MiMo、Command Code 等内置订阅迁到社区插件；部分旧 Go 实现已退役，见 [`migrate.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/provider/migrate.go) 和 [`market.json`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/plugin/market.json)。**后续找新的反代来源，优先审阅社区包，不只看主仓库同名文件。**

本次重点读取了 [`packages/workbuddy`](https://github.com/magpie-community/plugins/tree/7fdc07f15097ad06d8d03076b4f653ab42c687f9/packages/workbuddy)，可以接续 [已有 WorkBuddy 调研](./workbuddy-proxy-research.md)：

- 国内 `workbuddy` 与国际 `workbuddy-ai` 分开，提供浏览器登录、按账号刷新、企业身份头和企业额度查询。
- 模型目录来自 `/v3/config` 的 CLI agent，而不是仅依赖种子或旧目录。
- 有工具名称碰撞处理、调用名恢复及多种 JSON Schema 兼容修正。
- 明确指出 WorkBuddy 5.6+ 的加密桌面登录文件无法直接读取，推荐浏览器登录。
- **会改写指令语义**：`developer → system`，删除/改写特定身份文本，遇到渠道拒绝时把 system 内容移到 user 的 `<instructions>`，并记住该改写。它能增加兼容性，但 AiTool 不应未经选择就沿用。

该插件源码只依赖 Node 内建模块，导出 OpenCode hook，对 AiTool 仍需要 ESM/CJS 边界和独立适配器接口。复用应聚焦登录、刷新、目录、额度和协议纯函数，继续沿用 `CLIProxyAPI → 本地适配器`。无需一开始就实现整个 OpenCode/pi 插件宿主。

其他包目前只确认仓库与入口存在，未完成真实协议/账号审计，不能宣称已经可集成。Claude 订阅通过本机 `claude` 程序和 MCP 桥接客户端工具，其会话/取消/工具调度复杂度也高于普通 API adapter，应后置。

## 暂不优先复制的部分

- **整个 Go 网关或 Wails UI**：与 AiTool 的核心和桌面方案重复；UI 也不属于 React 组件库。
- **通用 Bun 插件运行时和任意 JS 请求中间件**：进程通信、流式 backpressure、刷新、取消、更新和插件权限是一整套系统。先抽独立适配器；参数规则可以逐项声明式实现。
- **请求脱敏**：[`masking.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/masking/masking.go) 会替换请求值并恢复响应，与当前展示遮罩不同。代码路径、工具参数、schema、ID 和流式恢复都要保持语义；应作为后续独立功能设计。
- **正文录制、远程同步及默认遥测**：Magpie 有默认关闭的本地网关正文录制、WebDAV/S3 和发布版每日遥测。AiTool 的统计不保存正文，云上传需 opt-in；这些不应随其他功能一起引入。已有只读本地 CLI 会话不等于新增代理正文录制。
- **自动上下文调优 / RTK / 预热**：有省 token 和改善额度利用的价值，但会改变压缩频率、shell 输出或实际消耗。以后可做明确的建议/开关，不能把 token 回放估算当作任务质量改善或真实账单保证。

## 建议排期

下面是单人熟悉仓库、复用现有组件时的量级估算，不是承诺；包含有针对性的测试，跨平台验证和上游变动可能拉长。

| 阶段 | 交付内容 | 量级 | 主要依赖 |
| --- | --- | --- | --- |
| 第一批 | MCP 检查 + 工具列表；随后单工具开关/变量引用 | 4–7 个工作日 | stdio/HTTP 生命周期、各客户端原生映射 |
| 第一批 | 配置差异、可达性和重启提示 | 2–4 个工作日 | 现有投影与环境检查；先不推断绕过 |
| 第一批 | 跨应用方案 | 2–4 个工作日 | Profile scope、预检查、分项结果与恢复 |
| 第一批 | WorkBuddy/Zed 客户端配置适配 | 每个 1–3 个工作日 | 客户端版本、JSON/JSONC 和恢复验证 |
| 第二批 | 可选 Magpie 上游：发现、目录、固定模型、停用恢复 | 2–4 个工作日 | 已安装 Magpie、协议验证和循环检查 |
| 第二批 | 搜索/视觉 MCP、具名子代理、项目分发 | 每项 3–6 个工作日 | 能力矩阵、作用域及用量归属 |
| 后续 | 原生跨模型/额度路由、intent、完整插件宿主、请求脱敏 | 单项至少 1–3 周 | 请求层/核心事件、计费语义和维护范围先确定 |

最建议先开工的是 **MCP 检查与单工具管理**：现有入口齐全，日常收益直接，也不依赖另一套代理核心。如果优先目标是“新增可调用的订阅”，则先做 **可选 Magpie 上游 + 单独审阅 WorkBuddy 社区插件**。

## 验证范围与后续验收

本次 WorkBuddy 插件 `node --check` 通过；隔离执行以下五项检查全部通过：

1. 企业身份生成 `X-Enterprise-Id` / `X-Tenant-Id`。
2. `max_completion_tokens:8` 转 `max_tokens:8`，同时观察 `developer → system`。
3. `systemAsUser` 确实把 system 指令放进 user，作为不直接复用的依据。
4. 两个会碰撞的工具名归一后仍不同，且保留恢复映射。
5. mock `/v3/config` 返回 CLI 模型、上下文和积分倍率，并携带企业头。

这些检查只证明所审阅纯逻辑的行为，没有外部网络、真实凭证或用户配置写入；不能代替订阅登录、流式工具往返、取消和完整计费验证。没有为文档改动运行 AiTool 的完整 CI。

实施时最低验收：固定目标版本；临时 HOME 下验证配置写入/移除、用户手改保留和并发修订；模拟 stdio/HTTP MCP 失败/取消；若接 Magpie，验证三种主要客户端协议的流式/非流式、多轮工具、失败中断、实际模型和缓存/reasoning 计数，并确认不会重复入账。真实账号测试要与合成测试单独标注。

文档亦有滞后：Magpie 的 `docs/integrating.md` 写着不能通过插件增加 Agent 行，但当前 [`plugged.go`](https://github.com/yetone/magpie/blob/86254d4049cb6be4a2ccdab02edf0bd59860c603/internal/agent/plugged.go) 与 agent-wiring 文档已有 agent 插件路径；README 又明确不接收外部 PR。维护和扩展判断应以所选提交的实现为准。
