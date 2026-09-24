# Open Managed Agents

Open Managed Agents（OMA）是一个用于创建、运行和管理长时间运行 Agent 的平台。它把 Agent、Session、Workspace、Skill 和事件流组织在同一个 API 与控制台中，并支持把 Agent 放入受控 Sandbox 执行任务。

## 基础功能

- **Agent 管理**：创建、查询、更新、删除和 Fork Agent；为 Agent 配置模型、提示词、工作区和 Skill。
- **Session 执行**：创建 Session，向 Session 发送多轮输入，观察 Turn、排队输入和执行状态。
- **事件流**：通过事件列表或 SSE 读取 Agent 输出、错误和 `session.turn_completed` 等 Complete Event。
- **Workspace 文件**：上传输入文件，读取文件元数据，生成签名下载地址，下载 Agent 产生的结果。
- **Skill Library**：上传、读取、更新和导出 Skill，并为 Agent equip/unequip Skill Fork。
- **Sandbox 运行时**：在受控 Sandbox 中运行 Agent 工具和工作流；部署配置位于 [`sandbox/`](sandbox/) 与 [`deploy/`](deploy/)。
- **Web 控制台**：`web/` 提供 Agent、Session、Workspace 和事件的可视化操作入口。

核心概念和边界见 [`CONTEXT.md`](CONTEXT.md)。完整 HTTP 接口以 [`docs/openapi.json`](docs/openapi.json) 和部署环境的 `/api/openapi.json` 为准。

## 仓库结构

| 目录 | 用途 |
| --- | --- |
| [`server/`](server/) | OMA API、持久化、Session/事件和 Sandbox 编排 |
| [`adapter/`](adapter/) | Agent 运行适配器与执行器 |
| [`web/`](web/) | React/Vite 控制台 |
| [`cli/`](cli/) | 独立的 TypeScript/npm 命令行客户端 `oma-cli` |
| [`sandbox/`](sandbox/) | 可部署的 Sandbox 镜像和运行时定义 |
| [`deploy/`](deploy/) | Kubernetes、镜像和发布脚本 |
| [`docs/`](docs/) | API、设计、验证和接入文档 |

## 本地开发

要求 Node.js 22+、pnpm 10+。

```bash
pnpm install

# 仅启动内存存储的 API，默认 http://localhost:3000
pnpm dev:server

# 启动前端（另开一个终端），默认 http://localhost:5173
pnpm dev:web
```

需要完整依赖时使用 `pnpm dev:full`。常用检查命令：

```bash
pnpm test                 # adapter 测试
pnpm typecheck            # adapter 类型检查
pnpm --dir server test
pnpm --dir server typecheck
pnpm openapi:check
pnpm test:cli             # oma-cli 构建和测试
pnpm typecheck:cli
```

## oma-cli

`oma-cli` 是面向脚本、CI 和其他 Agent 的非交互命令行客户端。它使用 OMA Host 的 HTTP API，不依赖本仓库运行时；要求 Node.js 22+，运行时没有额外 npm 依赖。

### 功能范围

| 命令组 | 能力 |
| --- | --- |
| `agent` | Agent 的 list/get/create/update/fork/delete |
| `agent file` | 读写和管理 Agent 文件 |
| `workspace` | Workspace 的 list/get/create/rename/delete |
| `workspace file` | list/read/write/url/rename/delete/upload/download |
| `skill` | Skill Library 的 list/get/upload/delete 和文件操作 |
| `skill download` | 把 Skill Fork 导出到本地目录 |
| `agent skill` | 查看、equip、unequip Agent Skill Fork |
| `session` | Session 的 list/get/create/rename/delete/pending/send/interrupt/wait |
| `session events` | 事件 list/read/follow，支持 Complete Event NDJSON |
| `schema`、`guide`、`doctor`、`version` | 离线查看命令契约、内置指南、连接诊断和版本 |

CLI 默认输出结构化 JSON；交互终端可使用 table，脚本可使用 `--format json|csv|ndjson`、`--field` 或 `--raw`。命令默认非交互、要求显式资源 ID，不会猜测当前资源，也不会自动重试写请求。`--dry-run` 只生成计划，不执行远端或本地写入。

### 安装

仓库当前只生成本地 tarball，不代表已发布到公共 npm registry：

```bash
pnpm pack:cli
npm install --global ./cli/oma-cli-local-0.1.0.tgz

oma-cli --version
oma-cli --help
```

也可以在不全局安装的情况下直接运行打包文件：

```bash
npm install /absolute/path/to/cli/oma-cli-local-0.1.0.tgz
./node_modules/.bin/oma-cli guide read --name oma-cli --raw
```

### 接入 OMA Host

在业务后端、CI 或自动化 Agent 所在环境设置 Host 地址和 API key：

```bash
export OMA_BASE_URL='https://your-oma-host.example.com/api'
export OMA_API_KEY='从平台方安全获取的 API key'

oma-cli doctor
oma-cli agent list
```

本地内存 API 可将 `OMA_BASE_URL` 设置为 `http://localhost:3000`；部署在带路径前缀的网关后时，地址需要包含完整前缀（例如 `/api`）。

生产环境示例地址是 `https://agentry.welltop.tech/api`。API key 通过 `x-api-key` 发送；不要把真实 key 写入仓库、前端代码、命令历史或日志。`--base-url` 和 `--api-key` 会覆盖同名环境变量：

```bash
oma-cli --base-url "$OMA_BASE_URL" --api-key "$OMA_API_KEY" agent list
```

CLI 不内置生产地址，也不负责申请或轮换 API key。API key 必须属于目标 Agent 所在 Tenant；直接使用 REST API 的接入流程见 [`docs/agent-api-key-integration.md`](docs/agent-api-key-integration.md)。

### 最小执行流程

下面的流程创建 Workspace 和 Session，上传输入文件，发送任务，等待队列排空，再下载输出文件。命令返回的真实 ID 应保存到业务系统中，不要依赖名称猜测资源。

```bash
# 1. 确认可访问的 Agent
oma-cli agent list

# 2. 创建 Workspace 并上传输入
oma-cli workspace create \
  --workspace-id workspace-example \
  --name "Example"
oma-cli workspace file upload \
  --workspace-id workspace-example \
  --path input.txt \
  --file ./input.txt

# 3. 创建 Session 并发送任务
oma-cli session create \
  --agent-id agent-example \
  --workspace-id workspace-example
oma-cli session send \
  --session-id session-example \
  --prompt "读取 input.txt，生成 output.txt，并保存到 Workspace。"

# 4. 等待并读取事件
oma-cli session wait --session-id session-example
oma-cli session events list --session-id session-example --all

# 5. 下载产物
oma-cli workspace file download \
  --workspace-id workspace-example \
  --path output.txt \
  --output ./output.txt
```

`session send` 返回的是已接受状态（HTTP 202），不表示任务已经完成。`session wait` 依赖 Host 的队列排空契约；生产集成仍应读取事件、检查错误并验证产物。对需要持续接收进度的程序，可使用 `session events follow`，它输出可重连、可去重的 Complete Event NDJSON。

### Skill 接入

```bash
oma-cli skill upload --directory ./example-skill
oma-cli agent skill equip \
  --agent-id agent-example \
  --skill-id library-example
oma-cli agent skill list --agent-id agent-example
oma-cli skill download \
  --skill-id fork-example \
  --output ./exported-skill
```

Skill 的公共库内容和 Agent 私有 Fork 分开管理；修改前先用 `skill list/get` 或 `agent skill list` 确认目标 ID。

### CLI 文档和诊断

```bash
oma-cli schema session wait
oma-cli guide list
oma-cli guide read --name oma-cli --raw
oma-cli doctor --format json
```

命令数据写入 stdout，诊断写入 stderr。常见退出码包括：参数/输入错误 `2`、认证/权限失败 `3`、网络或协议错误 `4`、超时 `124`、用户中断 `130`。完整工作流和恢复规则见 [`cli/guides/oma-cli.md`](cli/guides/oma-cli.md)，CLI 包说明见 [`cli/README.md`](cli/README.md)。

## 部署和生产 API

生产部署拓扑、镜像和 Kubernetes 操作见 [`deploy/README.md`](deploy/README.md)。API 与控制台共用同一域名时，API base URL 需要包含 `/api`，例如：

```text
https://agentry.welltop.tech/api
```

健康检查地址为 `/api/health`，OpenAPI 地址为 `/api/openapi.json`。部署、API key 权限和签名文件 URL 的安全边界以部署环境配置为准。

## 相关文档

- [项目上下文与领域术语](CONTEXT.md)
- [API Key 接入示例](docs/agent-api-key-integration.md)
- [OMA CLI 设计说明](docs/oma-cli-design.md)
- [OMA CLI 验证记录](docs/verification/oma-cli-2026-09-23.md)
- [部署说明](deploy/README.md)
