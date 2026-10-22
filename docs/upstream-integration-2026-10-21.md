# 上游更新实施计划与记录 — 2026-10-21

用户授权实施 [本次四上游评估](upstream-review-2026-10-21.md) 中所有适用候选。沿用 `dev`，保留既有会话阅读器工作区改动，应用版本不变。

## 实施顺序

- [x] Codex 新远程压缩用量格式；统一 analytics 与 transcript 计费，保护分页、fork、历史修复和重复扫描。
- [x] Hermes 内置 ID 提醒、新预设及显式迁移；API Key 输入保护。
- [x] CLIProxyAPI v8.0.37 基线与隔离核心兼容验证。
- [x] OAuth 单个/批量刷新、启停/删除逐项结果、问题筛选、凭证索引。
- [x] 单凭证重试/错误规则、xAI 模式与插件额度查询。
- [x] 核心有限自动恢复、状态展示与服务生命周期。
- [x] OpenCode Go / Command Code Key 本地保存及查询缓存失效。
- [x] Grok 共享额度产品占比。
- [x] 原生窗口可见性同步，隐藏时暂停界面刷新与倒计时。
- [x] Windows 手动启动激活、fnm 与 VS Code 被动识别。
- [x] Antigravity CLI 独立配置、模型、MCP、Skills、prompts 与只读会话。
- [x] Antigravity 官方多账号绑定与逐账号额度。
- [x] 扩展 OpenCode、Hermes、Grok Build、Pi、MiniMax 的只读会话来源。
- [x] Codex remote compaction 设置、智谱余额与火山套餐查询。
- [x] 托盘供应商快捷切换。
- [x] 全量 Node/dashboard 测试、类型检查、文案/架构校验、构建与浏览器检查。

不重复移植已实现的保护；不引入 Sentry、赞助预设、WebDAV 胶囊、第二套 Rust 代理或全套主题。平台/真实账号验证按可用环境记录边界。

## 实施结果

截至 **2026-10-22（北京时间）**，所有适用候选已在工作区实现。原会话因服务错误中断在收尾，本次续接重新执行最终验证，并完成界面复查与记录。应用版本保持 `0.1.0`；改动留在 `dev` 工作区，未发布。

### 统计与配置兼容

- Codex 支持新式相邻 `token_usage_record → token_count` 远程压缩记录，涵盖首次全零快照、已有请求后全零快照，以及累计计数已包含压缩请求的情况。普通记录仍由 token_count 计费，压缩按 response ID 去重；分页与 parent replay 使用同一状态机。CLI 会话费用复用 analytics 的用量解析。相关合成测试跨读取边界，并连续同步两次验证幂等。
- 历史纠正使用已有受控重建：追加纠正快照，保留共享队列原始字节和并发代理追加；失败/缺页/变更时不提交游标。没有在本机真实历史上执行重建。
- Hermes 新预设使用独立 `aitool-*` 标识；已有内置 ID 冲突显示提示并提供显式迁移，保留用户配置和备份。Key 输入关闭自动大写、纠错和拼写检查。
- Codex 编辑器增加 remote compaction 的继承/关闭/v2 设置。智谱/Z.ai 查询套餐窗口，明确未开通套餐时回退余额（余额 0 有效）；火山 Agent/Coding Plan 查询单独使用控制面 AK/SK，不复用推理 Key。

### 代理管理与额度

- `core-version.txt` 基线改为 `v8.0.37`，安装/更新测试改为围绕该基线验证稳定版和过期版行为。原会话已报告隔离 v8.0.37 管理接口兼容检查通过；其临时日志在续接时已不在磁盘，本次没有重复下载。只读检查确认本机安装核心仍为 **8.0.35**，代码基线变更不等于替换正在使用的核心。
- 凭据页增加单个/所选/服务端全部 OAuth 刷新、批量启停/删除、逐项结果及问题筛选。刷新有受限 300 秒超时，Node 返回白名单字段，不传出刷新 token 或原始失败响应。
- 刷新、启停通过 `auth_index` 定位。同名凭据的设置、模型和删除接口受上游限制，只按文件名查找，界面明确提示并禁止歧义操作；传入索引不能解决这些接口的限制。
- 单凭据重试次数、请求错误规则与 xAI 模式可以覆盖或恢复全局继承。插件额度只匹配唯一且已注册、支持 quota 的插件，展示窗口/余额；旧核心路由回退仅在 HTTP 404 时使用。保持原生额度查询入口，不引入插件商店。
- 服务端恢复监视独立于页面轮询：连续两次进程检查失败后按 2/5/15 秒退避，滚动五分钟最多三次。成功不清预算，手动启停/重启推进 generation，旧任务不能撤销新指令；外部核心不作为恢复对象，恢复同时重连用量桥和已启用适配器。
- OpenCode Go / Command Code Key 保存在 `~/.tokentracker/tracker/*-api-key.json`，权限 0600，环境变量优先，Command Code 保留 CLI 登录回退。界面仅读是否配置与来源；换 Key 使旧查询和缓存失效，避免旧结果覆盖新凭据。
- Grok 各产品行展示它们在同一个周额度池中的已用份额，不当作独立额度或重复加总。

### Antigravity 与会话来源

- `agy` 作为独立 app ID：供应商端点、Key、模型设置存入卡片；启动使用每供应商私有 `--gemini_dir`，共享定制配置链接到 `~/.gemini/config`。MCP 使用 `mcp_config.json`，Skills 使用 `skills/`，提示词使用 `AGENTS.md`。
- Unix 启动通过私有 socket 把 Key 传给终端子进程，终端命令参数和 `.command` 文件不含 Key；Windows 使用继承环境的 Windows Terminal。私有设置保留用户键并创建备份。模型目录解析 `agy models` 的原生别名/显示 ID。
- 官方卡可绑定已保存账号；切换先捕获当前登录并校验写回身份。PKCE 登录校验 state，过期/撤销账号保留重新认证状态。账号列表不返回凭据，额度刷新只更新该账号的本地副本，删除保存副本不退出 CLI。
- CLI Sessions 扩展为九款工具：Claude/Codex/Gemini/agy/OpenCode/Hermes/Grok Build/Pi/MiniMax。OpenCode 兼容 SQLite 与迁移前目录格式；Hermes 校准秒级时间戳；Pi 跟随当前分支；保留工具调用/结果配对、原生模型和缓存语义。agy 只有二进制记录时列出恢复命令，不伪造正文。
- 新来源沿用根目录和真实路径校验；数据库及 WAL、旧格式 companion 文件变化会使缓存/懒加载引用失效。价格按模型与来源的 token 语义估算，不以 `total_tokens` 计费。

### 桌面与界面收尾

- macOS、Windows、Linux 与 `desktop` 壳发送 `native:visibility`，隐藏/最小化暂停仪表盘读取与倒计时，恢复可见立即刷新；仅失去焦点不暂停。页面加载完成后再次同步原生可见状态，防止隐藏中重载重启轮询。
- Windows 二次手动启动唤起已有窗口，自启动保持安静；补 fnm 路径兜底，VS Code 安装检测只检查二进制。
- 各托盘增加「切换供应商」，打开已有 dashboard 内共用 selector，继续使用备份/冲突处理；初始加载期间保留打开请求。
- 续接修复手机账号行被多个操作按钮挤成逐字排列的问题；不支持 Profiles 的 app/工具标签跳过 Profiles 请求。新截图使用完整 API fixture，去掉此前 `currentIds` 缺失造成的测试数据异常提示。

## 最终验证

2026-10-22 续接重新执行的结果：

| 检查 | 结果 |
| --- | --- |
| `node --test --test-concurrency=2 test/*.test.js` | **4324 通过，12 跳过，0 失败**（4336 项） |
| `npm --prefix dashboard test -- --maxWorkers=1 --minWorkers=1` | **154 个文件、1173 项全部通过** |
| `npm --prefix dashboard run typecheck` | 通过 |
| `validate:copy` / `validate:locale` / `validate:ui-hardcode` / `validate:guardrails` | 全部通过；简繁中文各 3223/3223 keys |
| `npm run dashboard:build` / `git diff --check` | 通过；保留已有 chunk 体积提示 |
| 原生账号视图/架构静态回归 | 16 通过，1 跳过 |
| Reader Playwright | 1280px、390px：嵌套长输出搜索可见、大纲随滚动、跳到回复可见 |
| Management Playwright | 1440px、390px × 浅色/深色：账号额度与长邮箱排版、快捷切换、按索引批量刷新部分失败、插件额度、凭据设置通过，无页面异常 |
| Impeccable 检测及截图复查 | 本次新增管理组件无机械问题；完整流程人工复查通过 |

第一次续接 dashboard 全量仅有宠物皮肤的 200ms 性能阈值失败，单独复测通过，随后最终全量全部通过；未放宽阈值。原会话提到的 SessionsPage 偶发失败在本次两轮全量中均未复现。

日志位于 `/tmp/aitool-upstream-finish-20261022/`（临时文件）；截图位于 `.impeccable/review/`，本次完成版为 `*-finished-*`。Reader 浏览器脚本保留在 `dashboard/scripts/verify-cli-session-reader.mjs`。Management 浏览器检查采用合成 API fixture，未操作真实供应商或账号。

## 验证边界

- 当前 Linux 环境没有 Rust/.NET 编译工具链；macOS/Windows 原生运行也不可用。原生壳改动完成源码/现有静态检查，仍需各平台构建和运行验证。
- agy 官方账号切换依赖 macOS Keychain；Linux/Windows 显示平台限制，Key 模式启动仍可使用。Unix 私有 socket 启动已通过真实子进程 stub 集成验证，原生 `agy` 和真实 OAuth/额度未实测。
- 火山控制面、智谱、插件额度、Key 替换、恢复状态机均有合成回归；没有真实套餐或生产核心崩溃实测。agy 二进制会话只支持索引/恢复入口。
- 未升应用版本，未执行 npm/桌面发布或推送 tag；遵循个人 fork 的 `CLAUDE.md` 工作流。当前业务改动及既有会话阅读器改动留在工作区。
