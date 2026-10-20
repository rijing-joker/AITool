# 第一批上游更新集成 — 2026-10-20

接续 [四个上游更新评估](upstream-review-2026-10-20.md)，完成稳定性、数据准确性与 Codex 兼容修复。基线为 `dev` 的 `893e36a`；应用版本保持不变。未替换运行中的核心、修改真实 CLI 配置、执行真实账号推理或部署云端 edge functions。

## 已实现

| 范围 | 行为与边界 |
| --- | --- |
| CLIProxyAPI | `core-version.txt` 从 v8.0.32 更新到 v8.0.35；保留既有下载、分阶段升级及启动失败回滚机制。核心仍为外部进程，不纳入应用包。 |
| 队列缓存 | 使用完整 SHA256 摘要验证缓存和已提交前缀，识别中间改写后追加，以及同大小、同时间戳的改写。保留共享读取、分块异步处理和未完成尾行规则；内容未变时复用解析结果。 |
| ZCode 历史 | 从各安装数据库推导可重建窗口，采用最晚的起点；已有安装无法确认覆盖范围时延后历史修复。保留窗口之前的队列、桶和去重游标，从 `queue.jsonl.bak.*` 恢复较高的历史快照。修复逐行向共享队列追加归零/恢复快照，防止大块写入中途与代理记录交错；写入失败不提交游标，重试会重置上传偏移。 |
| OpenCode 零价 | 仅对 `source=opencode` 且型号以 `-free` 结尾的 analytics 记录提前返回零价；本地 matcher 与五份 edge 文件一致。免费代理适配器的模型准入、Proxy Requests 的 models.dev 定价没有放宽。 |
| Codex 模型目录 | 官方 GPT harness 与能力继续继承；显式行窗口覆盖 `context_window`/`max_context_window`，默认压缩阈值为窗口的 90%。live TOML 的全局窗口和压缩阈值优先。多层有效命名空间可查找官方模板，对外模型 ID 保持原样；导入再保存保留窗口。 |
| Codex 归档 | 支持 `.jsonl.zstd`，与 `.jsonl.zst`、普通 `.jsonl` 共享逻辑身份；重叠时优先普通文件，其次 `.zst`。统计、同步、会话列表/读取及归档后路径回退覆盖两种压缩后缀，仍校验目录边界。 |
| 用量隐私 | 实际核心验证发现 API-key executor 把上游密钥放在 `source`。归一化现在删除原文，保留 `source_hash` 供备注匹配；新记录落盘和历史记录 API 读取均不返回该原文。已有磁盘文件未重写。客户端密钥仍只保留摘要与遮罩。 |
| 控制帧 | 核心保存配置后发送的 `{refresh:true}` 与 `support_refresh` 一样属于控制通知。桥接与历史读取现在过滤两者，避免配置保存产生虚假的零 token 请求；正常零 token 请求继续保留。 |

ZCode 恢复依赖仍存在的备份，不能重造数据库和备份都已删除的历史；历史恢复按每个桶的最高总量快照选取，不累加多个备份。云端同步继续遵守现有 opt-in 门控。

## 自动检查

- `npm test`：**4285 项，4273 通过，12 跳过，0 失败**。
- 首批修改的集中回归：182 项通过；队列 API、目录选项与 parser 回归：311 项通过；最后一轮 ZCode 并发追加、用量控制帧和隐私回归：48 项通过。以上均包含在最终全量测试内。
- `validate:copy`、`validate:locale`、`validate:ui-hardcode`、`validate:guardrails` 均通过；dashboard production build 通过，仍有现有大 chunk 提示。
- 已验证 ZCode 写入中途失败后重试、代理并发追加、备份恢复幂等性，以及历史迁移后连续两轮 ledger 扫描；未在真实用户数据上执行重建。
- 修复一项与本批实现无关的测试日期问题：Kiro 2.13 的固定 7 月数据在 10 月 20 日超过 90 天游标窗口。该测试固定时钟，继续测试窗口内的改写行为，不改变生产保留策略。

队列性能使用 100000 行、约 51.8 MB 的临时合成 JSONL，在本机 Node 22.21.1 验证：冷读 361 ms，三次摘要校验 97 / 86 / 102 ms，追加后校验 90 ms；累计只解析 100001 行。摘要校验仍是 O(文件大小) 的读取，保留每 64 KiB 让出事件循环；这些结果不代表慢盘或更大真实队列的固定延迟。

## 真实核心与合成上游验证

新增可复用脚本：

```bash
node scripts/acceptance/proxy-core-smoke.cjs /absolute/path/to/cli-proxy-api
```

脚本使用独立临时目录、随机 loopback 端口和测试密钥，启动指定二进制和本地合成 OpenAI-compatible 上游。仅发送固定测试消息，工具结果是合成值，不执行工具；结束后停止测试进程并清理临时目录。

验证二进制为官方 `CLIProxyAPI_8.0.35_linux_amd64.tar.gz`，下载包 SHA256 与发布记录一致：

```text
1d9edde6973e8f15694debcd186b5ab693e0741bd6a4c5e551aa89e0a6b57e38
```

通过的检查包括：

- Chat Completions / Anthropic Messages / Responses / Gemini 四种客户端协议，各自流式与非流式的文本、工具响应，共 16 条组合；流式工具参数拆片后保留工具名和参数。
- Chat 工具结果的流式和非流式第二轮往返，不执行任何真实工具。
- RESP 用量桥接重连后累计桶连续；19 个成功请求累计 fresh input 1425、cached input 475、output 380。每次 output 中含 reasoning 5，队列不再把 reasoning 单独累加。
- 真实 v8 管理 API 的 ETag 条件写入返回 200，旧修订再次写入返回 412。测试配置遵循 v8 的逐 key `proxy-url` 位置。
- 原始客户端密钥与上游密钥均不出现在 AiTool 新写入的请求记录中。
- 19 条正常请求和 4 条截断请求共 23 次上游调用、23 条请求记录，配置刷新通知不计入请求数。

这些验证走的是 **OpenAICompatExecutor** 和合成上游，不能证明所有原生 executor、OAuth 刷新、真实供应商请求或其他操作系统均已实测。下载/回滚路径另由仓库自动测试覆盖。

## v8.0.35 截断检测的实际限制

合成上游只发内容增量，然后正常关闭 HTTP 流，不发送 `finish_reason` 或 `[DONE]`。客户端 HTTP 头已经发出，因此以下请求均返回 HTTP 200，失败与否应看流内错误和用量状态。

| 客户端协议 | 核心用量记录 | 结论 |
| --- | --- | --- |
| Anthropic Messages | `failed=true`、failure status 502 | 正确记录异常结束 |
| Responses | `failed=true`、failure status 502 | 正确记录异常结束 |
| Chat Completions | `failed=false`、failure status 200 | 仍会把此类 clean EOF 记作成功 |
| Gemini | `failed=false`、failure status 200 | 仍会把此类 clean EOF 记作成功 |

因此 v8.0.35 的上游发布说明不能解读为“所有协议都检测截断”。验收脚本输出每种协议的结果，并要求 Claude/Responses 路径保持失败检测；Chat/Gemini 这一缺口需要后续核心版本解决。AiTool 的管理层不接触推理流，仅凭零 token 无法可靠识别截断，不在统计层猜测并修改成功状态。

## 后续范围

代理异常退出自动恢复、Grok 产品额度占比、Windows 启动唤起与工具识别、remote compaction、套餐查询和托盘面板仍是原评估中的后续批次。WorkBuddy 接入调研属于独立任务，本批没有实现其适配器。
