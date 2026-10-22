# CLI 会话与 cc-switch 实现对比 — 2026-10-21

Method: dual-agent (A: /root/session_design_review · B: /root/session_technical_review)

已切回 `dev`。审查基线为 AiTool `2bc4751`，对照 cc-switch 默认分支固定提交 [`c776fd0ebfe35d769b5909b86bdfa1ccdf089988`](https://github.com/farion1231/cc-switch/tree/c776fd0ebfe35d769b5909b86bdfa1ccdf089988)。前半部分记录该基线的审查结果，后面的实施状态记录用户确认后的实现。

**结论：AiTool 已移植分组列表和阅读器的交互骨架，但仍使用最小消息模型；cc-switch 的工具摘要、结果状态、统一 diff、内容导航和正文细节更完整。用户感受到的差距有具体实现依据，单改颜色和字号无法解决。**

AiTool 实际运行页面检查了 1440×900 和 390×844、浅色与深色。所有会话使用合成数据，浏览器拦截真实本地 API 与外部请求。cc-switch 对照来自上述固定提交的组件和 Rust 源码，未运行其应用；因此不宣称进行了两款应用同屏或逐像素对比。

## 已有能力与主要差异

两者都有按项目/时间分组、应用筛选、列表元数据搜索、独立阅读器、问题分轮、折叠过程、全部/对话/改动筛选、查找、大纲与 Markdown 导出。AiTool 的列表返回状态保留、虚拟列表、会话目录边界校验和本地阅读行为值得保留。

| 方面 | AiTool 审查基线实现 | cc-switch 对照源码 | 实际影响 |
| --- | --- | --- | --- |
| 工具折叠摘要 | 主要显示 `Read`、`Edit`、`Bash`，同类工具没有操作对象 | 动作 + 路径/命令/搜索目标 + 状态、退出码、时长或增删行；按来源使用原生叫法 | 我们需要逐个展开才能知道发生了什么 |
| 整轮执行摘要 | 步数和已识别失败数 | 步数、命令数、修改文件数、失败数、耗时；支持连续同类成功步骤合并 | cc-switch 在折叠时保留更多判断线索 |
| 改动展示 | Claude Edit/MultiEdit/Write 参数仍为 JSON；专门 diff 仅覆盖 Codex `apply_patch` | 从编辑参数还原 diff，优先采用结果提供的真实 diff；文件段、增删行、可用行号、hunk 分隔 | 我们的“改动”较接近工具类别筛选，尚未成为统一代码变更阅读器 |
| 角色和正文 | 通用用户/助手标记，反复显示完整日期；所有来源共用绿色气泡 | 来源头像/符号与动作语言；问题和助手输出具有明确列关系，减少重复信息 | cc-switch 更容易辨认来源和执行语义 |
| 代码与路径 | 基本 Markdown 和代码背景；用户提问中的围栏代码仍为纯文本，无独立代码复制 | 专门代码块含语言标签与复制；用户提问也识别围栏代码；路径可缩短、复制或由桌面层定位 | 技术内容更像可操作的阅读材料 |
| 查找 | 明确按“匹配轮次”计数，导航到轮首；工具输出另有内部滚动 | 记录命中所在问题/答复/步骤，定位相应行；不可见 Markdown 原文命中有片段兜底 | 我们可能显示命中数但屏幕上看不到命中 |
| 大纲 | 问题预览；高亮只由点击/查找更新 | 问题和答复双入口、步数/失败提示；当前项跟随阅读位置 | cc-switch 更适合快速回到结论 |
| 列表密度 | 会话行至少 80px，应用文字放在摘要前；标题来自有限头部消息 | 会话行 56px，全部应用模式有图标，显示归档标记；Codex 叠加索引/数据库标题 | 我们同屏条目较少，标题与摘要质量也影响观感 |
| 长内容 | 普通文件全读后返回整份 JSON；前端超过 60 轮时按整轮虚拟化；思考超过 32KiB 永久截断 | 元数据文件缓存与头尾局部读取，正文解析缓存、分块 IPC、全文引用按需分页；按阅读行虚拟化 | 长历史扫描、重复打开和展开过程的成本不同 |
| 功能范围 | 此页面只读 Claude/Codex/Gemini；恢复命令复制 | 更多会话来源、相邻会话切换、更多复制方式、终端恢复、删除和批量操作 | 属于产品范围差异，不能用 analytics 支持数量代表 transcript 支持数量 |

cc-switch 后端扫描还包括 OpenCode、OpenClaw、Hermes、Grok Build、Pi、MiniMax Code、AGY；用户可见入口受其应用设置影响。终端恢复与删除依赖桌面能力，移植时应独立评估。AiTool 的只读设计不构成缺陷。

长内容对比需要区分：cc-switch 的 `stream_session_messages` 仍先调用 `load_transcript` 完成解析，再发送 Header/Messages/Done；其优势包括缓存、分块传输和全文按需读取，不能描述为边扫描源文件边展示首批消息。

## 优先问题

### P1：先补工具结果和消息语义

1. **Codex 注入上下文被当成真人提问，甚至成为标题。** 合成日志按顺序包含 AGENTS.md、环境上下文、真实问题、答复，列表标题实际是 `# AGENTS.md instructions...`，阅读接口返回三个普通 user 消息，页面会分成三轮。`src/lib/sessions.js:542` 过滤标题时未排除 AGENTS；`:753` 读取正文没有 injected 分类；`dashboard/src/pages/cli-sessions-model.js:152` 遇到 user 即开始新轮。上游解析器会分别处理 injected 内容，阅读器默认隐藏它们，并叠加 Codex 原生索引/数据库标题。

2. **Gemini 工具结果和状态丢失。** `src/lib/sessions.js:1035` 只保留工具名与 args，丢掉 id、status、result、resultDisplay。原始工具记录包含明确 error 和输出，读取后无法查看或搜索该错误。成功编辑提供的真实 diff 也未保留。

3. **Codex 普通命令失败没有进入失败统计。** `src/lib/sessions.js:775` 保留工具输出原文，只对 apply_patch 特判状态。合成 `{"output":"1 failed","metadata":{"exit_code":1}}` 显示为中性 exec_command，失败数为空，输出还包含 JSON 外壳。应按明确退出码和结构化状态判断，并显示解包正文。

4. **Claude 混合 user 内容中的结果失配。** 一个 user 记录同时含 tool_result 和文字时，解析器保留二者，但轮次模型先把它作为新问题返回，忽略 toolResults。结果内容被并入提问，错误标志和调用配对失效。应按内容块分别处理结果和真人文字。

这些问题说明需要为现有三种来源统一调用 ID、工具类别、操作对象、结果状态、退出码、diff、注入标记等字段。可保留 CommonJS 后端和现有 HTTP API，不需要迁入 Rust/Tauri 来获得这些语义。

### P1：折叠时保留“做了什么”

`dashboard/src/pages/cli-session-content.jsx:440` 直接使用工具名作为标签；`:483` 展开后展示完整参数。应增加语义摘要，例如 `Read(cli-session-content.jsx:300–389)`、`Bash(npm test)`、`Update(cli-session-content.jsx) +1 −1`。

Edit/MultiEdit 的 old/new、Write 的 content 可生成输入 diff；结果提供 structuredPatch/fileDiff 时以结果为准。明确区分“提出的变更”和“已应用”，不能仅有编辑调用就显示成功。失败或没有最终答复的过程也应有可见线索，上游对此有专门展开和失败保留规则。

对应上游：`reader/toolSummary.ts`、`SessionTimeline.tsx`、`SessionDiff.tsx`、`SessionStepDetails.tsx` 和各 provider 的结果回填。

### P1：让查找结果真的可见

`dashboard/src/pages/cli-session-reader.jsx:150` 以轮次收集命中，`:163` 只滚到轮首。390×844 下查找 `text-sm`，首个高亮 y=978，等待后仍不进入首屏。

更长输出的复现：450 行工具输出在第 441 行含 SEARCHTAIL；查找后轮和工具都展开，显示 `1 / 1 个匹配轮次`，但内部 pre.scrollTop=0，命中 y=11082，可见框仅 y=517–805。应记录命中块及位置，在展开/虚拟测量完成后同时定位外层阅读区域和内层内容框。

“匹配轮次”是当前明确文案，计数本身不算错误。原 Markdown 语法或 URL 中的命中不可见时，应提供原文片段，而不是宣称没有命中。

### P2：大纲、代码与排版

`dashboard/src/pages/cli-session-reader.jsx:169` 仅在 jumpTo 更新 activeTurn。点击第一轮后手动滚到第五轮，目录仍通过 aria-current 宣称位于第一轮。应从可见轮次计算当前项，增加问题/答复双目标与失败提示。

正文 `cli-session-content.jsx:338` 的 11px 元数据在浅色使用约 #a3a3a3 对 #fafafa，实测对比度约 2.4:1；暗色未选中阅读筛选约 3.2:1。功能性次级文字应达到 AA，消息时间可显示时分，完整日期放在页头/提示中。保留手机 40px 操作目标，不直接照搬上游 24/32px 桌面控件。

补充专门代码块与路径呈现。当前 apply_patch 仍保留协议标记并软换行，缺少行号/hunk 结构；普通 Edit 则是 JSON，二者应采用一致阅读方式。无需为了改善技术内容盲目更换整套 Markdown 引擎。

### P2：错误与内容完整性

读取错误目前直接显示后台字符串，且页面可能同时显示 0 轮；错误旁缺少重试/返回操作。应本地化可理解的状态、提供就近恢复入口，将技术详情保留为次级内容。

思考正文超过 32KiB 被永久截断，需明确标记限制或增加全文读取；普通消息 >3000 字与补丁 >400 行的前端折叠可恢复，应区别对待。混合模型估算在只有部分模型有价格时显示部分总和，未标记覆盖率，这是成本完整性边界。

## 设计评分与使用体验

| Nielsen 启发式 | 0–4 分 | 依据 |
| --- | ---: | --- |
| 系统状态可见 | 3 | 基本状态清楚，大纲位置过期 |
| 符合现实世界 | 3 | 问题→过程→答复自然，工具对象缺失 |
| 用户控制与自由 | 3 | 返回与折叠良好，缺答复直达 |
| 一致性与标准 | 3 | 共享 tokens 一致，Changes 内过程开关无效 |
| 错误预防 | 4 | 只读任务不会破坏源日志 |
| 识别优于记忆 | 2 | 同名工具需逐个打开 |
| 灵活性与效率 | 2 | 快捷查找可用，定位不够精确 |
| 美观与最小化 | 3 | 主线清楚，元数据偏淡，控制区较高 |
| 错误识别与恢复 | 1 | 后台错误缺就近恢复说明 |
| 帮助与文档 | 1 | 恢复命令与下一步解释不足 |
| **合计** | **25/40** | 独立 A 评估；未对上游进行同等评分 |

列表认知负荷较低，展开阅读器为中等。熟练用户最受工具对象缺失、Edit JSON 和命中不可见影响；新手容易困惑于复制恢复命令后如何使用；低视力用户受淡色元数据影响。没有发现主流程不可用键盘完成的 P0，40px 目标和绿色焦点应保留。

整体阅读的正向节点是列表找到任务与看到最终答复；负担集中在进一步查看执行证据时。优先改善这一阶段，比增加装饰性颜色更有价值。

## 验证与证据限制

- Node `test/cli-sessions.test.js`：34/34 通过；dashboard 会话页面/模型：22/22 通过。未新增测试，现有用例没有完整覆盖上述边界。
- 100 轮虚拟列表中查找第 90 轮可渲染，未复现虚拟列表搜索整体失效；390px 深色页面无整页横向溢出。
- CLI detector 对四个页面组件一次扫描退出 0，0 发现。真实浏览器 detector 另发现低对比度；部分 tiny-text 分类不准确，nested-cards/原文 h3/flat hierarchy 不应机械视为产品错误。
- B 在三个独立 headless 页面成功注入 live overlay，结果分别为亮色列表 6 个元素组/10 规则、亮色阅读器 9/15、暗色手机 4/5。没有原生可见浏览器入口，不宣称用户现在能看见覆盖层。
- 临时 overlay server 和所有审查浏览器已停止；用于审查的 Vite 在交付前停止。真实会话文件和用户配置未修改。

截图保存于本聊天的可视化目录：

- [现有桌面阅读器](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/aitool-cli-sessions-reader.png)
- [工具折叠摘要](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/design-a-desktop-light-process.png)
- [Edit 与 apply_patch 展示](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/technical-b-changes-edit-patch.png)
- [长输出命中不可见](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/technical-b-search-tail-hidden.png)
- [大纲位置过期](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/technical-b-outline-stale-repro.png)

## 改进顺序

1. 修正现有三种 CLI 的注入分类、工具结果/错误、混合内容配对，形成轻量统一消息结构。
2. 做语义工具摘要、统一 diff、失败与未完成状态；优先解决“看具体改了什么”。
3. 做命中位置与内层滚动、大纲跟随/答复直达；补代码复制、路径和元数据对比度。
4. 对长历史再优化头尾扫描、元数据/正文缓存、全文按需读取和虚拟化粒度。

新增来源、终端恢复和批量删除另行定范围。视觉语言可继续沿用 AiTool 的设计 tokens，不必复制 cc-switch 的整套主题。

后续选择：优先解决「工具摘要与 diff」「整体阅读排版」「搜索与导航」中的哪项？范围选择「现有三种 CLI 阅读器」「连同新增来源和桌面操作」？


## 2026-10-21 实施结果

用户确认后，已在 `dev` 实施现有三种 CLI 阅读器的优先改进。上文描述的是审查时的旧实现；本节记录改进后的状态。

- Codex 注入上下文与真人提问分开，阅读轮次和 Markdown 导出默认隐藏注入内容；保留 IDE 包裹中的实际问题，优先采用本地 `session_index.jsonl` 的标题。
- Claude 混合 user/tool_result 正确配对，保留单结果的 structuredPatch、Bash 明确退出码与调用到结果的耗时；Gemini 保留工具 ID、输出、失败/中断/等待状态、模型和真实 fileDiff。Codex 命令输出解包后用于阅读，原始封套仍保留在消息正文中。
- 折叠工具行显示文件/命令/搜索目标、状态、增删行或退出码；执行摘要显示命令数、文件数、失败数和已知命令耗时。失败步骤始终有入口，无最终答复的轮次默认显示过程。
- Edit/MultiEdit/Write 与 apply_patch 使用统一差异视图，优先真实结果；由工具参数还原的内容有明确提示，未知文件行号不编造。保留空白、水平滚动、完整展开与路径复制。
- 搜索在展开和虚拟测量后同时定位外层阅读器与内部输出框；Markdown URL/语法命中提供原文片段。大纲跟随滚动并提供独立答复入口，手机有关闭按钮。
- 用户围栏代码也按 Markdown 阅读，代码块有语言和复制按钮；消息时间缩短为时分，元数据改用可读字号/对比度。读取失败显示本地化恢复操作和折叠技术详情；思考截断和部分模型定价有提示。
- 元数据使用完整行头尾局部读取与 512 项文件 stat 缓存；标题索引有独立缓存，所有路径仍先通过目录边界验证。未增加会话正文上传、写日志、终端操作或删除。

验证：完整 Node 测试 4281 通过、12 跳过、0 失败；会话前端测试 39/39；构建、类型检查、copy/locale/ui-hardcode/guardrails 通过。设计 detector 对最终页面源文件扫描一次，0 发现。浏览器使用合成会话验证 1440px/768px/390px 和深浅主题；100 轮中第 441 行的工具输出命中进入可见区域，手动滚动更新大纲、答复直达通过。列表 250/40 条、桌面/手机、连续三次返回均保持滚动位置。

可重复浏览器检查：`dashboard/scripts/verify-cli-session-reader.mjs` 和已有 `verify-cli-session-scroll.mjs`，支持 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。所有临时验证服务在交付前停止，真实会话与用户配置未修改。

最终截图：

- [工具摘要（桌面深色）](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/implemented-reader-1440-dark.png)
- [差异视图（手机深色）](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/implemented-diff-390-dark.png)
- [答复、大纲与代码复制](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/implemented-answer-outline.png)
- [读取失败恢复](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/implemented-error-mobile.png)

第一轮之后的正文缓存、按需读取和思考截断差距，在下面的第二轮继续补齐。


## 第二轮实施：过程合并与长正文（2026-10-21）

- 连续成功的读取/搜索、同一 MCP 服务调用合并为可展开摘要；至少两步才合并，失败、中断、等待状态和中间消息会中止合并。原始步骤保持搜索、导出、结果配对和计数的来源，搜索自动展开命中子步骤。
- MCP 摘要显示服务、工具、查询/网址；网页调用解析搜索请求和链接；代理任务显示任务摘要，展开后展示代理类型、模型、代理 ID 等已存在字段，完整参数仍可查看。通用工具保留原始数据，不推断未知字段。
- 路径优先显示项目相对路径，其余家目录用 `~/`；助手最终答复带来源图标，轮次间距收紧，触摸目标仍至少 40px。
- 正文解析结果使用进程内 8 会话/96 MiB LRU，无正文磁盘缓存。每次请求仍先校验根目录与真实路径；文件 stat（含 inode/ctime）、Codex 页集合/压缩替代路径和可能父日志参与版本指纹。未完成的 fork replay 不缓存，读取中变化的文件不提交快照。
- `/api/cli-sessions/read` 默认保持完整正文兼容；`preview=1` 将超过 4096 字符的消息、思考、结果正文换成 1200 字符预览和字段引用。`/api/cli-sessions/content` 按 revision/ref/offset 读取，每页最多 128 Ki 字符（UTF-16 字符范围，非字节范围），版本变化或越界路径会拒绝。
- 前端展开长字段时读取一页，可继续加载；复制消息取完整字段。搜索和 Markdown 导出显式读取同版本完整会话，预览阶段不报告部分命中数量，失败可重试或重新读取。思考正文不再永久限制为 32 KiB。

验证：完整 Node 测试 **4286 通过、12 跳过、0 失败**；会话前端 **45/45**；构建、类型检查、作用域 ESLint、copy/locale/ui-hardcode/guardrails 通过。新增回归涵盖 LRU 容量与隔离、长思考尾部、API 分页、过期引用、缓存后 symlink 越界、Codex 父文件消失/恢复及新增页、全文复制/导出和搜索重试。浏览器合成数据在 **1440/768/390px × 深浅主题** 下验证组内搜索可见、三页连续加载、失败常显、代理字段、无整页横向溢出；已有 100 轮虚拟会话搜索/大纲测试仍通过。

- [第二轮阅读器（桌面深色）](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/continued-reader-1440-dark.png)
- [第二轮阅读器（手机浅色）](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/continued-reader-390-light.png)
- [代理任务详情（桌面）](/home/lrj-linux/.codex/visualizations/2026/10/21/01a15d22-857e-7453-bf63-64d2fb6213bc/continued-agent-1440-dark.png)

当前剩余差距：仍按整轮虚拟化，首次读取仍完整解析源日志；搜索仍按匹配轮次导航。长工具参数/diff 尚未改为字段分页，Codex 为确保 fork 正确性仍扫描并指纹整个日志清单（无关日志变化也可能使当前版本失效）。图片 lightbox/本地按需图片、相邻会话导航、Codex stateDB 标题及更多来源、原生恢复/删除未引入；不同 CLI 的动作语言和每轮首个助手输出的头像规则尚未完全复刻上游。
