# OpenAPI 与 Apifox 同步

业务接入请先看 [通过 API Key 调用 Agent 并获取产物](agent-api-key-integration.md)，包含 cURL 流程和可运行的 Python 示例。

## 线上核查与修订：2026-09-15

- 正式 API 基址为 `https://agentry.welltop.tech/api`；[线上 OpenAPI JSON](https://agentry.welltop.tech/api/openapi.json) 反映已部署版本。`/api` 是代理前缀，接口路径仍为 `/v1/...`。缺少 `/api` 的 `/openapi.json` 返回 Web 页面。
- 已用本地有效 Apifox token 将当前仓库契约导入专用项目，并把 [公开文档站](https://f2imdh2qly.apifox.cn) 绑定到正确 API 环境。公开索引已回读为 **54 个接口、46 个模型**，旧 Session messages 接口及三个专用模型已移除；54 个公开接口页的方法、路径、说明、状态码和 API 地址均已核对。
- GitHub Repository variable `PUBLIC_API_URL` 已更新并回读为 `https://agentry.welltop.tech/api`。本地 CLI 的默认登录失败不表示没有有效 token：本机 `APIFOX_TOKEN` 需显式映射到工具使用的凭据参数；不要打印或写入仓库。
- 最近一次 [GitHub 同步运行 34878322577](https://github.com/BroZhong/open-managed-agents/actions/runs/34878322577) 在 `schemaIgnored=49` 时失败。本次回读证实这 49 个模型内容未变；未变化的 endpoint 甚至可能不计入任何计数。仓库已修正计数判断，并新增完整导出内容校验，不能再凭导入成功或资源总数一致宣布同步成功。
- **仍不能保证 Apifox 逐字段一致。** 导入未正确绑定受限接口鉴权，且 Workspace multipart 上传的 `anyOf` 在导入后丢失。公开 Markdown 的 3.0.1 转换还丢失任意 JSON 类型、请求体必填标记和 SSE 第二响应类型。新增检查会报告这些差异，不把平台转换损失当作等价格式忽略。鉴权修复的最终合并状态见 [审计报告](api-documentation-audit-2026-09-15.md)。
- 未配置 Runner 定时导入；每 180 分钟配置只是可选模板。本地接口删除及 CI 修订尚未部署或在 `main` 执行，线上契约仍有 55 个接口，且其 `servers` 元数据仍缺少 `/api`。不要混淆当前源码、已部署服务与 Apifox 三个版本。

完整测试覆盖、修订清单、平台限制和发布状态见 [API 文档审计报告](api-documentation-audit-2026-09-15.md)。

## 同步关系

本项目以 TypeScript OpenAPI 契约生成文档，Hono 负责实际请求处理。主要同步链路是：

```text
API route contract 或模型变更
  -> pnpm openapi:generate
  -> docs/openapi.json
  -> 合并到 main，OpenAPI contract CI 通过
  -> GitHub Actions 导入 Apifox
  -> 导入及校验成功后，Apifox 文档站展示项目内容
```

GitHub Actions 导入的是通过 CI 的提交中的 `docs/openapi.json`，不读取线上 `/openapi.json`，也不等待后端部署成功。代码合并、API 部署、Apifox 导入是不同步骤，因此文档可能早于或晚于线上 API。已发布文档站会随 Apifox 项目内的内容变化，但这不等于它与实际部署实时一致。[Apifox 关于已发布文档实时更新的说明](https://docs.apifox.com/5838811m0)

另有独立的可选路径：部署后的 API 基址 + `/openapi.json` → 已配置的客户端或 Runner 定时拉取 → Apifox。此路径的状态与 CI 导入分开检查。

GitHub Actions 会先核对项目 ID、项目名称（可选再核对团队 ID），并要求目标项目为空或已包含本服务的两个哨兵接口；通过后才把生成文件推送到 Apifox。工作流使用 Apifox 官方 Open API 的覆盖模式更新所有同 method/path 接口和同名数据模型，并删除 contract 中不再存在的资源。导入前会分别对当前 HTTP endpoint 和 schema 清单执行删除上限检查；导入后检查官方计数中报告的失败，确认远端 endpoint/schema 集合完全一致，再通过官方 OpenAPI 3.1 导出逐项回读接口请求、响应、鉴权、描述和模型内容。资源计数不能替代内容比较。配置 `PUBLIC_API_URL` 时，导入还会创建或更新对应的 Apifox 环境；工作流会按规范化后的 `baseUrls.default` 唯一匹配该环境，并把它设为已发布文档站唯一且默认的在线调试环境。这条即时同步路径不依赖 Runner。两类资源默认各允许删除 10 个，超过时工作流会先失败。若团队另行配置自托管 Runner，工作流还会确保存在一个指向远端 `/openapi.json` 的定时导入设置，作为独立的周期同步保障。

## 本地生成与校验

在仓库根目录运行：

```bash
pnpm openapi:generate
pnpm openapi:check
pnpm --dir server --filter @oma-server/api test
node --test .github/scripts/apifox-*.test.mjs
```

`openapi:generate` 会确定性地更新 `docs/openapi.json`。`openapi:check` 不写文件；如果提交的文件落后于 TypeScript 契约，它会失败。每个 Hono route factory 都从同一份 contract 注册 method/path 和本地 OpenAPI registry；契约测试会逐个比较两者，确保它们一一对应。

新增或修改接口时，以 `server/packages/api/src/openapi/` 中的 contract 为源，并提交生成后的 `docs/openapi.json`。route factory 通过 `operationId` 绑定 contract，因此路径和方法不再在 handler 中重复书写；Hono 在进入业务 handler 前也会执行同一份 Zod params、query、headers 和 body schema，包括 multipart 与贪婪文件路径的适配。响应不会在生产请求中额外解析或序列化，仍由 TypeScript 模型和行为测试约束。

## 提供远端 OpenAPI 服务

服务内的契约路由是 `GET /openapi.json`；当前公网部署通过 `/api` 前缀访问：

```text
GET https://agentry.welltop.tech/api/openapi.json
```

此端点不需要 API key，并返回 `Cache-Control: public, max-age=300`。若要让文档中的在线调试请求真实后端，部署时设置：

```bash
PUBLIC_API_URL=https://agentry.welltop.tech/api
```

这样 OpenAPI 的 `servers[0].url` 会指向真实 API 地址。合法值必须是公网 HTTPS API 基址，可以包含路径前缀，例如 `https://agentry.welltop.tech/api` 或 `https://api.example.com:8443`；不能使用 `/openapi.json` 文档资源作为基址，也不能包含查询参数、fragment、内嵌用户名密码，或使用 localhost、特殊用途域名、私网/保留 IP。末尾 `/` 会被规范化。暂时不配置时，同步工作流会从发布用 OpenAPI 中移除 `servers`，因此仍可在线预览文档但不会展示一个虚假的 localhost 调试地址；配置 Runner 远端拉取时则必须提供该值。

2026-09-15 的核查发现旧 URL 校验仅接受 origin，与 `/api` 前缀部署不一致。本次仓库已允许 API 路径前缀；环境匹配保留完整基址，Runner 数据源只在其后追加一次 `/openapi.json`。GitHub variable 和 Apifox 环境已修正，后端部署中的 `PUBLIC_API_URL` 仍须在发布时与之对齐。

当前公网 Ingress 已将 `/api/*` 转发给 API Service，Service 本身仍可保持 `ClusterIP`。文档站调试或定时导入应使用完整的 API 基址；只有新增部署才需要另行配置 Ingress、域名和 TLS。

也可以在 Apifox 中使用 `https://agentry.welltop.tech/api/openapi.json` 新建定时导入。该 URL 必须直接返回 OpenAPI JSON/YAML，不能只检查 HTTP 200。默认方式要求有写权限的用户在客户端或 Web 中打开项目；支持相应功能的自托管 Runner 可独立按间隔拉取。[Apifox 定时导入](https://docs.apifox.com/scheduled-import)

参考：[导入 OpenAPI 开放 API](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873)、[导入设置](https://docs.apifox.com/import-settings)、[Apifox CLI](https://docs.apifox.com/doc-5637756)。

## 一次性配置 Apifox 和 GitHub

1. 登录 [Apifox Web](https://app.apifox.com/)，为本服务创建一个专用 HTTP API 项目。不要在该项目中混放人工维护的其他 API；精确同步会删除远端契约中不存在的资源。
2. 在 Apifox 账户设置中创建 API Access Token，并记下项目 ID。
3. 在项目的“分享文档 -> 发布文档站”中配置可见性并点击“立即发布”。复制公开地址，并通过 `apifox docs-site list --project <PROJECT_ID>` 读取真正的文档站 ID；不要把项目 ID 当作文档站 ID。
4. 在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 中创建 Repository secrets：`APIFOX_ACCESS_TOKEN`、`APIFOX_PROJECT_ID`。
5. 创建 Repository variables：
   - `PUBLIC_API_URL`：可选，部署后的公网 HTTPS API 基址；当前部署应使用 `https://agentry.welltop.tech/api`，不要带 `/openapi.json`。配置后，工作流会把 OpenAPI 导入生成的同 URL 环境绑定为文档站的唯一默认在线调试环境；不填时仍可发布文档，但在线调试不可用；配置 Runner 时必填。
   - `APIFOX_EXPECTED_PROJECT_NAME`：必填，专用项目的精确名称；导入前会与项目 ID 一起校验。
   - `APIFOX_EXPECTED_TEAM_ID`：可选，项目所属团队 ID；建议填写以防同名项目误配。
   - `APIFOX_DOCS_SITE_ID`：上一步已发布文档站的 ID。
   - `APIFOX_DOCS_URL`：必填，已发布站点的 Apifox 系统域名 HTTPS origin；保持“系统访问地址”启用。工作流会实际访问并要求返回成功。
   - `APIFOX_MAX_ENDPOINT_DELETIONS`：可选，单次允许删除的旧 endpoint 数，默认 `10`；大规模有意删除时经审核后临时调高。
   - `APIFOX_MAX_SCHEMA_DELETIONS`：可选，单次允许删除的旧 schema 数，默认 `10`；与 endpoint 删除上限独立。
   - `APIFOX_RUNNER_ID`：可选；团队套餐支持定时导入、且已经部署并启动的通用 Runner ID。
   - `APIFOX_RUNNER_TYPE`：可选且依赖 Runner ID；团队 Runner 使用默认值 `TSHGR`，组织 Runner 填 `OSHGR`。
6. 可选：若需要无人值守的远端定时拉取，先确认团队套餐支持 Runner 定时导入，再在“团队资源 -> 通用 Runner”中部署并启动 Runner，并填写上面两个 Runner 变量。
7. 若已部署公网 API，在 API 部署环境中把 `PUBLIC_API_URL` 设置为同一个完整 API 基址。
8. 在 `main` 分支手动运行一次 `Sync OpenAPI to Apifox`。以后 API 契约合并到 `main` 且契约 CI 通过后会自动同步。

Apifox CLI 2.2.7 可以创建或更新文档站配置，但没有独立的发布命令；创建配置不等于完成首次公开发布。因此首次“立即发布”保留为 UI 操作。工作流会严格核对文档站 ID、项目 ID、发布状态、公开可见性和系统域名，要求 `APIFOX_DOCS_URL` 是该站点的精确 `*.apifox.cn` HTTPS origin。自定义域名可以另行对外展示，但 CI 固定验证 Apifox 系统域名，以免请求不受信任的 DNS 目标。可达性检查不跟随重定向，并限制响应大小、类型与最小内容长度，避免把任意页面误报为在线文档。已发布站点会实时反映 Apifox 项目内文档的变化。

参考：[发布文档站](https://docs.apifox.com/publish-documentation-site)。

## GitHub Actions 自动同步

`Sync OpenAPI to Apifox` 工作流只接受 `main`；以下是它的实现和成功条件，不代表最近一次运行已完成这些步骤：

- 自动运行时，checkout 已通过 `OpenAPI contract` 的准确 commit SHA。
- 手动运行时，也会重新执行生成一致性、Hono route inventory 和 Redocly 校验。
- 配置了 `PUBLIC_API_URL` 时，使用临时 OpenAPI 文件替换 `servers[0].url`；未配置时删除临时文件中的 `servers`。两种情况都不修改仓库中的确定性产物。
- 官方 Open API 导入显式使用 `OVERWRITE_EXISTING` 覆盖接口和数据模型，并启用 `deleteUnmatchedResources`。任何报告的失败、非法计数或超过本地总数的计数都会失败。实测未变化的模型会记为 `ignored`，未变化的接口可能完全不计数；因此导入返回成功只表示请求被接受，不能证明同步完成。
- 接口清单使用 Apifox CLI 的无分页全量读取，并校验 `data.length = returned = total`、响应无后续页、接口 ID 和 method/path 均唯一。实测分页查询可能跨页重复同一 ID 并漏掉另一接口；不能通过简单去重修复。CLI 输出先写入权限为 `0600` 的临时文件，避免子进程管道中观察到的 8 KB 截断，读取后立即清理。响应不完整或超过 16 MiB 读取上限会使同步停止。
- 安全 reconciler 会在导入前分别限制计划删除的 endpoint/schema 数，在导入后确认没有缺失或重复的 method/path，并验证远端集合与本地完全一致。
- 配置了 `PUBLIC_API_URL` 时，工作流会在导入后读取环境列表，只接受 `baseUrls.default` 与规范化 URL 完全相等的唯一环境；然后先读取文档站的完整 `environments` 对象，只替换其中的 `environmentIds` 和 `defaultEnvironmentId`，同时更新默认文档版本的环境绑定并保留其他版本；经 Apifox CLI schema 校验后更新，再重新读取并验证两层精确绑定。零个或多个匹配都会让同步失败，避免把 Try-it 请求发往错误环境。
- 配置了 Runner 时，`docs/apifox-auto-import.json` 会额外创建远端定时同步；同名配置漂移时会重建。未配置 Runner 时跳过这个周期保障，不影响官方 Open API 的即时精确同步。
- 必须通过官方 OpenAPI 3.1 导出回读核对完整 operation/schema 集合、请求和响应、描述和示例、有效鉴权以及绑定环境 URL。继承的全局鉴权与 operation 级声明按同一含义比较，公共接口的 `security: []` 仍须保留。任一实际差异都使工作流失败；仅忽略经过测试的等价格式差异。
- 最后检查指定文档站已经发布，并从 GitHub Runner 实际访问公开 URL。

仓库的可选定时导入配置使用 180 分钟间隔。Runner 必须保持 Started；未配置 Runner 时，CI 仍可走官方 Open API 导入，但是否成功要检查整次运行。已配置的 Runner 离线会使后续 Runner 检查失败，不能据此假设此前的导入被撤销。免费团队也可以配置每 3 小时由客户端拉取一次，作为项目打开时的额外周期路径。

本地手动导入时，不要直接导入仓库中指向 localhost 的 `servers`。可以先生成临时文件，再调用与 CI 相同且显式覆盖冲突的脚本：

```bash
public_api_url="$(node .github/scripts/apifox-public-api-url.mjs "$PUBLIC_API_URL")"
jq --arg url "$public_api_url" '.servers[0].url = $url' \
  docs/openapi.json > /tmp/openapi.json

APIFOX_PROJECT_ID="$APIFOX_PROJECT_ID" \
APIFOX_ACCESS_TOKEN="$APIFOX_ACCESS_TOKEN" \
node .github/scripts/apifox-import.mjs --spec /tmp/openapi.json

# 环境绑定及鉴权同步后，回读实际发布环境；ENVIRONMENT_ID 来自已核对的文档站配置。
APIFOX_PROJECT_ID="$APIFOX_PROJECT_ID" \
APIFOX_ACCESS_TOKEN="$APIFOX_ACCESS_TOKEN" \
node .github/scripts/apifox-verify-contract.mjs \
  --spec /tmp/openapi.json --environment "$APIFOX_ENVIRONMENT_ID"
```

不要把 Access Token 写入仓库、OpenAPI 文件或 workflow YAML。

## 是否需要付费

2026-09-15 核对的 [Apifox 价格页](https://apifox.com/pricing/) 仍列出免费版 `¥0`、每 3 小时一次定时导入，商业旗舰版支持多个文档站及选择发布范围。文档站提供默认 `*.apifox.cn` 地址。Runner 定时导入的套餐权限应以团队账户和价格页功能对比为准。

本项目的 CI 直接调用开放 API，不依赖 Runner；API 地址漂移已修正；鉴权和导出内容差异需按审计报告处理，不能把购买套餐当作同步已经恢复的证据。若另行要求 Runner 独立定时拉取，再评估相应套餐。
