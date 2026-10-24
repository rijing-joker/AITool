# 审查文本核实与修复

两份原始审查共 19 条，锁路径问题重复一次，合并为 18 类。当前代码中均有对应缺陷或可改进的边界；路由校验、恢复备份和授权读取配置本身具有用途，修复保留这些能力。

| 问题 | 核实结论与修复 |
| --- | --- |
| 二次清空分发删除整个 `.gitignore` | 属实。只移除归属匹配的受管区块，释放空区块的回执；二次应用保留用户行。见 `src/lib/provider-switch/library-distribution.js`。 |
| 诊断回执失败阻止 current 更新 | 属实。配置写入成功后先提交对应 provider 指针，诊断回执失败返回警告，保留可重试状态。切换、编辑保存和修复均覆盖。见 `src/lib/provider-switch/api.js`。 |
| 路由每请求重复管理读取、额度查询及串行事件落盘 | 调用链属实，原报告未测量具体延迟。防循环校验保留，管理快照共享 5 秒；成功快照可容忍最长 30 秒的管理读取失败，冷读取失败仍拒绝。额度共享 30 秒，事件按 100 毫秒批次写入，不阻塞响应完成。见 `src/lib/proxy/extensions/routing.js`。 |
| 组合方案部分成功却恢复旧 current | 属实。部分成功时清除 current 方案标记，避免误指旧方案及自动保存混合状态。实际配置和恢复清单保留，不盲目回滚用户文件。见 `src/lib/provider-switch/profile-bundles.js`。 |
| app 校验晚于锁路径构造 | 属实。切换、保存、断开和诊断修复统一在创建锁前验证 app。见 `src/lib/provider-switch/api.js`。 |
| 恢复副本无限累积 | 属实，但副本用于恢复。已完成副本保留最近 20 次、最长 30 天；活动、结果不确定和回执引用的副本保留。二次预检拒绝且无配置写入时删除本次副本。见 `src/lib/provider-switch/recovery-retention.js`。 |
| 断开时保留用户编辑过的 slot 却删除指针 | 属实。slot 被用户修改时一并保留它的指针。见 `src/lib/provider-switch/additive.js`。 |
| 畸形 MCP 环境引用导致列表整体失败 | 属实。列举引用容忍畸形导入，新保存严格验证列表、映射及变量名称，允许从 UI 修正。见 `src/lib/provider-switch/mcp-envrefs.js` 和 `mcp.js`。 |
| 诊断预览默认返回明文凭据 | 属实，但接口原本已要求本地授权且支持查看配置。默认仅返回路径及是否变化，主动勾选显示内容后才读取全文，隐藏时清除前端保存的全文。见 `src/lib/provider-switch/api.js` 和 `dashboard/src/pages/provider-diagnostics.jsx`。 |
| macOS/Windows 托盘重载绕过草稿保护 | 属实。改用 `native:providers` 页内事件；初次加载时保留待打开状态，不重载已有页面。见两平台的 DashboardWindow 控制器。 |
| 凭据设置草稿未接入路由守卫 | 属实。上报 dirty/busy 状态到 ProxyPage，卸载清理；后退触发丢弃确认，取消保留草稿。见 `dashboard/src/pages/auth-files-tab.jsx` 和 `ProxyPage.jsx`。 |
| 技能复制失败暴露半成品且先删旧投影 | 属实。在临时目录准备完整链接或副本，完成后核对归属并替换；失败保留/恢复旧投影，回滚本身失败时保留恢复副本。见 `src/lib/provider-switch/skills.js`。 |
| 无关 Codex rollout 变化使读取失效 | 属实。revision 只纳入选中线程页面和声明的 fork 父页面；继续发现新增相关页、压缩替代及父页变化。仍扫描目录以发现新页，但不再对所有无关文件做 realpath/stat 或指纹校验。见 `src/lib/sessions.js`。 |
| agy 未知 keychain 原文无恢复路径地落盘 | 属实。无法解码当前登录时拒绝切换，保持钥匙串原值，不新建原文 stash。过去版本已有的 stash 不自动删除，以免破坏唯一恢复副本。见 `src/lib/provider-switch/agy-accounts.js`。 |
| agy 已删除账号切换后重新出现 | 属实。切换前捕获也遵守 dismissed 标记；删除保存账号继续不影响实时登录。见 `src/lib/provider-switch/agy-accounts.js`。 |
| transcript preview 未限制工具参数/补丁 | 属实。参数、补丁及结构化结果使用有 revision 的分页引用；补丁预览保留执行状态、文件及增删摘要，正文加载后使用完整补丁，避免无退出码的拒绝结果丢失失败计数。展开时加载完整字段，搜索/导出继续读取完整会话。见 `src/lib/session-transcript-cache.js` 及会话组件。 |
| macOS 完全遮挡仍上报可见 | 属实。可见性同时要求 `occlusionState.contains(.visible)`。见 `TokenTrackerBar/TokenTrackerBar/Services/DashboardWindowController.swift`。 |
| agy 账号显示绕过隐私模式 | 属实。列表及绑定选择器使用共享隐私文本处理，保留原始路由账号 ID。见 `dashboard/src/pages/provider-agy-accounts.jsx`。 |

## 验证

- 提交前后端全量：4,411 通过，12 跳过，零失败。
- 提交前前端全量：157 个测试文件、1,192 项通过、1 项榜单冷启动测试超时；榜单文件单独复测 16 项全部通过，未修改榜单代码。
- 最后两处后端加固（技能恢复失败保留副本、预览返回对象隔离）之后，相关 35 项测试通过。
- 复审补丁状态修复后，相关后端 61 项、前端 52 项测试通过；回归覆盖无退出码的补丁拒绝、正文加载前的失败计数与文件摘要，以及正文加载后的完整差异。
- 文案、语言覆盖、UI 硬编码、架构校验、TypeScript 检查及 dashboard 构建通过。Impeccable 检测结果为空。
- Chromium 使用合成接口响应渲染实际组件：1440px 和 390px 下诊断默认隐藏/主动查看/再次隐藏、agy 身份脱敏、后退保护和取消保留草稿均通过，无页面异常和横向溢出。临时测试入口已移除。
- macOS/Windows 宿主、真实钥匙串和真实订阅服务未在 Linux 上运行；原生改动完成源码核查，账号逻辑使用注入的钥匙串实现测试。

未更改版本或发布，未操作用户真实配置或凭据。
