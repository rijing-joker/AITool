<div align="center">

# AiTool

**English** · 简体中文

### 一个工具箱搞定 AI 编码工作流 —— 多提供商 AI 网关 + Token 用量仪表盘，合一的本地应用。

AiTool 把两个开源项目融合为一个本地优先的产品：

- **AI 代理**（来自 [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) / [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，MIT）—— 在本地运行网关，把你的服务提供方账号通过 OpenAI / Anthropic / Gemini 兼容端点暴露出去，并记录每次请求的用量。
- **Token 用量分析**（来自 [TokenTracker](https://github.com/xiufengsun/TokenTracker)，MIT）—— 本地优先的仪表盘，追踪 41 款 AI 编码工具的 Token 用量与成本。

UI 全程使用 TokenTracker 的设计语言 —— 一个仪表盘覆盖两个世界：代理请求会汇入与原生 CLI 工具相同的趋势、模型分解和成本视图。

</div>

---

## 融合方式

```
┌────────────────────────────── AiTool 仪表盘 (localhost:7680) ────────────────────────────────┐
│  侧边栏                                                                                       │
│  ├── AI Proxy        ← 新增：代理生命周期、服务提供方、密钥、请求级记录、配置                    │
│  └── Tokens / Sessions / Limits / …  ← TokenTracker 分析（41 款 CLI 工具），保持不变            │
└──────────────┬──────────────────────────────────────────────────────────┬────────────────────┘
               │ /api/proxy/*                                             │ /functions/*（本地 API）
               ▼                                                          ▼
   Node 代理层 (src/lib/proxy)                             TokenTracker 数据面 (~/.tokentracker)
   ├── core 管理器    — 拉起 cli-proxy-api                  ├── queue.jsonl  ← 半小时用量桶
   ├── 管理 API 客户端 (Bearer 密钥)                         ├── 成本引擎（70+ 模型定价）
   └── 用量桥 — RESP SUBSCRIBE usage ──────────────────────►└── 融合：代理用量 = source "cliproxy"
        └── 请求级记录 → ~/.aitool/proxy/usage/*.jsonl
```

core 二进制保持为外部可独立更新的进程（`core-version.txt` 钉住版本，与 EasyCLIProxyAPI 相同的模式）。用量桥把每个成功的代理请求折叠进 TokenTracker 的半小时桶，因此**代理用量会自动出现在标准仪表盘** —— 趋势、模型分解、成本、热力图 —— 与 Claude Code、Codex、Gemini 等其余 38 款被追踪工具并列。

## 快速开始

环境要求：Node.js 20+。代理 core 额外支持 macOS / Linux / Windows（自动获取 Go 构建的二进制）。

### 桌面应用（推荐）

```bash
cd desktop && npm install && npx tauri build
open src-tauri/target/release/bundle/macos/AiTool.app   # macOS；同时产出 .dmg
```

原生窗口 + 系统托盘（打开 / 启动代理 / 停止代理 / 退出）。壳会自动挑空闲端口、拉起 Node 服务，等代理健康后打开仪表盘；关窗隐藏到托盘，退出时一并停掉服务与代理 core。详见 [desktop/README.md](./desktop/README.md)。

### 终端方式

```bash
npm install                # 根目录 CLI + 依赖
npm --prefix dashboard install
npm run dashboard:build

node bin/tracker.js proxy install    # 获取钉住版本的 CLIProxyAPI core（或：AITOOL_CORE_BIN=/path/to/cli-proxy-api node bin/tracker.js proxy install）
node bin/tracker.js serve            # 仪表盘 http://localhost:7680 —— 代理随之启动
```

也可以通过 CLI 管理代理：

```bash
aitool proxy status     # core + 桥接状态
aitool proxy start      # 启动 core + 用量桥
aitool proxy stop
aitool proxy config     # 显示路径与端点
```

## AI 代理能力（来自 EasyCLIProxyAPI）

通过仪表盘的 **AI Proxy** 页（标签页）或 core 的管理 API 管理：

| 功能 | 页面标签 |
| --- | --- |
| core 生命周期（启动 / 停止 / 健康检查 / 版本） | Overview |
| 客户端访问密钥（`access.api-keys`） | Access Keys |
| 兼容端点 —— `/v1/chat/completions`、`/v1/messages`、`/v1beta/models` | Access Keys |
| 服务提供方凭据文件（上传 / 列表 / 删除 / 刷新） | Providers |
| 请求级用量记录（模型、提供商、Token、延迟、失败） | Requests |
| 通过 core 管理 API 编辑 `config.yaml` | Settings |
| 随仪表盘自启动 | Settings |

磁盘布局：`~/.aitool/proxy/` —— `bin/`（core）、`config.yaml`、`auths/`（提供方凭据）、`usage/`（请求级记录 + 桶状态）、`logs/core.log`。

默认端点：`http://127.0.0.1:8318`（仅本机回环；端口可在 config.yaml 修改）。明文管理密钥保存在 `~/.aitool/proxy/settings.json` —— core 首次加载时会把自己配置里的副本哈希掉。

## Token 用量分析（来自 TokenTracker）

| | |
| --- | --- |
| **支持的 AI 工具数** | **41** |
| **仪表盘** | localhost:7680 —— 趋势、模型分解、成本、热力图 |
| **代理用量来源** | `cliproxy` —— 自动汇入同一批视图 |

并入的 TokenTracker CLI 全部功能继续可用：41 款 AI 编码工具（Claude Code、Codex、Gemini、Cursor、Droid 等）的 hook 安装、本地 JSONL 解析、成本引擎、sessions、限额、成就、技能面板、桌面宠物、小组件 —— 同一个仪表盘在 `localhost:7680`。代理用量以 `cliproxy` 来源出现在同一批视图中。

```bash
aitool            # 打开仪表盘
aitool sync       # 手动同步本地工具日志
aitool status     # hook 挂接状态
aitool doctor     # 健康检查
```

## 项目结构

```
bin/tracker.js           CLI 入口 (aitool)
src/cli.js               命令分发（serve/sync/status/…/proxy）
src/lib/local-api.js     本地 API：/functions/*（用量）+ /api/proxy/*（新增）
src/lib/proxy/           新增 — paths / config / manager / 管理 API 客户端 / 用量桥 / REST 处理
src/commands/proxy.js    新增 — `aitool proxy …` 命令
dashboard/               TokenTracker 仪表盘（Vite + React + Tailwind，oai 设计系统）
  └── src/pages/ProxyPage.jsx   新增 — AI Proxy 页（5 个标签）
scripts/fetch-core.cjs   新增 — 下载钉住版本的 CLIProxyAPI release 二进制
core-version.txt         新增 — 钉住的 core 版本
```

## 第三方项目

- [TokenTracker](https://github.com/xiufengsun/TokenTracker)（MIT）—— 作为基座并入：CLI、仪表盘、设计系统。
- [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)（MIT）—— GUI-over-core 架构与功能集的参考；AiTool 用 Node 重新实现了管理层。
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（MIT）—— 代理引擎，运行时作为外部二进制下载（不并入仓库）。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)（来自 TokenTracker）。
