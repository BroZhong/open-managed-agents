# OpenAPI 与 Apifox 同步

本项目以 TypeScript OpenAPI 契约生成文档，Hono 负责实际请求处理。同步链路是：

```text
API route contract 或模型变更
  -> pnpm openapi:generate
  -> docs/openapi.json
  -> GET /openapi.json
  -> OpenAPI contract CI
  -> GitHub Actions 导入 Apifox
  -> Apifox 已发布的文档站实时展示项目内容
```

GitHub Actions 会先核对项目 ID、项目名称（可选再核对团队 ID），并要求目标项目为空或已包含本服务的两个哨兵接口；通过后才把生成文件推送到 Apifox。工作流使用 Apifox 官方 Open API 的覆盖模式更新所有同 method/path 接口和同名数据模型，并删除 contract 中不再存在的资源。导入前会分别对当前 HTTP endpoint 和 schema 清单执行删除上限检查；导入后还会校验官方返回的 created/updated/failed/ignored 计数，再断言远端 endpoint/schema 集合完全一致。这条即时同步路径不依赖 Runner。两类资源默认各允许删除 10 个，超过时工作流会先失败。若团队另行配置自托管 Runner，工作流还会确保存在一个指向远端 `/openapi.json` 的定时导入设置，作为独立的周期同步保障。

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

服务启动后会公开提供：

```text
GET https://<API 域名>/openapi.json
```

此端点不需要 API key，并返回 `Cache-Control: public, max-age=300`。若要让文档中的在线调试请求真实后端，部署时设置：

```bash
PUBLIC_API_URL=https://api.example.com
```

这样 OpenAPI 的 `servers[0].url` 会指向真实 API 地址。合法值必须是公网 HTTPS origin，例如 `https://api.example.com` 或 `https://api.example.com:8443`；不能包含 `/openapi.json` 等路径、查询参数、fragment、内嵌用户名密码，也不能使用 localhost、特殊用途域名或私网/保留 IP。末尾 `/` 会被规范化。暂时不配置时，同步工作流会从发布用 OpenAPI 中移除 `servers`，因此仍可在线预览文档但不会展示一个虚假的 localhost 调试地址；配置 Runner 远端拉取时则必须提供该值。

当前 Kubernetes Service 是集群内的 `ClusterIP`；若要让 Apifox 云端从 URL 拉取或启用在线调试，还需要配置公网 Ingress、域名和 TLS。不要只暴露文档而意外放开原本受保护的 `/v1/*` 接口。

也可以在 Apifox 中手动用 `https://<API 域名>/openapi.json` 新建定时导入。该 URL 必须直接返回 OpenAPI JSON/YAML，而不是 Swagger UI HTML。免费版每 3 小时可拉取一次，但需要有写权限的用户打开 Apifox 客户端和项目；商业专业版可用 Runner 实现无人值守拉取。内网服务可使用 Runner，或者只使用 CI 文件导入。

参考：[导入 OpenAPI 开放 API](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873)、[导入设置](https://docs.apifox.com/import-settings)、[Apifox CLI](https://docs.apifox.com/doc-5637756)。

## 一次性配置 Apifox 和 GitHub

1. 登录 [Apifox Web](https://app.apifox.com/)，为本服务创建一个专用 HTTP API 项目。不要在该项目中混放人工维护的其他 API；精确同步会删除远端契约中不存在的资源。
2. 在 Apifox 账户设置中创建 API Access Token，并记下项目 ID。
3. 在项目的“分享文档 -> 发布文档站”中配置可见性并点击“立即发布”。复制公开地址，并通过 `apifox docs-site list --project <PROJECT_ID>` 读取真正的文档站 ID；不要把项目 ID 当作文档站 ID。
4. 在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 中创建 Repository secrets：`APIFOX_ACCESS_TOKEN`、`APIFOX_PROJECT_ID`。
5. 创建 Repository variables：
   - `PUBLIC_API_URL`：可选，部署后的公网 HTTPS API origin，例如 `https://api.example.com`；不要带 `/openapi.json`。不填时仍可发布文档，但在线调试不可用；配置 Runner 时必填。
   - `APIFOX_EXPECTED_PROJECT_NAME`：必填，专用项目的精确名称；导入前会与项目 ID 一起校验。
   - `APIFOX_EXPECTED_TEAM_ID`：可选，项目所属团队 ID；建议填写以防同名项目误配。
   - `APIFOX_DOCS_SITE_ID`：上一步已发布文档站的 ID。
   - `APIFOX_DOCS_URL`：必填，已发布站点的 Apifox 系统域名 HTTPS origin；保持“系统访问地址”启用。工作流会实际访问并要求返回成功。
   - `APIFOX_MAX_ENDPOINT_DELETIONS`：可选，单次允许删除的旧 endpoint 数，默认 `10`；大规模有意删除时经审核后临时调高。
   - `APIFOX_MAX_SCHEMA_DELETIONS`：可选，单次允许删除的旧 schema 数，默认 `10`；与 endpoint 删除上限独立。
   - `APIFOX_RUNNER_ID`：可选；商业专业版中已经部署并启动的通用 Runner ID。
   - `APIFOX_RUNNER_TYPE`：可选且依赖 Runner ID；团队 Runner 使用默认值 `TSHGR`，组织 Runner 填 `OSHGR`。
6. 可选：若需要完全无人值守的远端定时拉取，在 Apifox 商业专业版的“团队资源 -> 通用 Runner”中部署并启动 Runner，再填写上面两个 Runner 变量。
7. 若已部署公网 API，在 API 部署环境中把 `PUBLIC_API_URL` 设置为同一个 origin。
8. 在 `main` 分支手动运行一次 `Sync OpenAPI to Apifox`。以后 API 契约合并到 `main` 且契约 CI 通过后会自动同步。

Apifox CLI 2.2.7 可以创建或更新文档站配置，但没有独立的发布命令；创建配置不等于完成首次公开发布。因此首次“立即发布”保留为 UI 操作。工作流会严格核对文档站 ID、项目 ID、发布状态、公开可见性和系统域名，要求 `APIFOX_DOCS_URL` 是该站点的精确 `*.apifox.cn` HTTPS origin。自定义域名可以另行对外展示，但 CI 固定验证 Apifox 系统域名，以免请求不受信任的 DNS 目标。可达性检查不跟随重定向，并限制响应大小、类型与最小内容长度，避免把任意页面误报为在线文档。已发布站点会实时反映 Apifox 项目内文档的变化。

参考：[发布文档站](https://docs.apifox.com/publish-documentation-site)。

## GitHub Actions 自动同步

`Sync OpenAPI to Apifox` 工作流只接受 `main`：

- 自动运行时，checkout 已通过 `OpenAPI contract` 的准确 commit SHA。
- 手动运行时，也会重新执行生成一致性、Hono route inventory 和 Redocly 校验。
- 配置了 `PUBLIC_API_URL` 时，使用临时 OpenAPI 文件替换 `servers[0].url`；未配置时保留生成产物并继续发布文档，不会修改仓库中的确定性产物。
- 官方 Open API 导入显式使用 `OVERWRITE_EXISTING` 覆盖接口和数据模型，并启用 `deleteUnmatchedResources`；工作流要求 created+updated 数分别等于本地 operation/schema 数，且 failed/ignored 均为零，避免“新增成功、旧接口未更新”的假绿。
- 安全 reconciler 会在导入前限制计划删除的 endpoint 数，在导入后确认没有缺失或重复的 method/path，并验证远端集合与本地完全一致。
- 配置了 Runner 时，`docs/apifox-auto-import.json` 会额外创建远端定时同步；同名配置漂移时会重建。未配置 Runner 时跳过这个周期保障，不影响官方 Open API 的即时精确同步。
- 最后检查指定文档站已经发布，并从 GitHub Runner 实际访问公开 URL。

仓库的可选定时导入配置使用 180 分钟间隔。Runner 必须保持 Started；未配置或离线期间，CI 仍会通过官方 Open API 精确覆盖 endpoint/schema 并清理不匹配资源。免费团队也可以在 Apifox 客户端中配置每 3 小时拉取一次，作为项目打开时的额外周期保障。

本地手动导入时，不要直接导入仓库中指向 localhost 的 `servers`。可以先生成临时文件，再调用与 CI 相同且显式覆盖冲突的脚本：

```bash
jq --arg url "${PUBLIC_API_URL%/}" '.servers[0].url = $url' \
  docs/openapi.json > /tmp/openapi.json

APIFOX_PROJECT_ID="$APIFOX_PROJECT_ID" \
APIFOX_ACCESS_TOKEN="$APIFOX_ACCESS_TOKEN" \
node .github/scripts/apifox-import.mjs --spec /tmp/openapi.json
```

不要把 Access Token 写入仓库、OpenAPI 文件或 workflow YAML。

## 是否需要付费

截至 2026 年 7 月，Apifox 免费版为 `¥0`，包含一个在线文档站、托管分享和每 3 小时一次的定时导入；默认可以获得 `xxx.apifox.cn` 地址。Runner 发起的无人值守定时导入从商业专业版起提供；多个文档站和对子站点单独选择发布范围从商业旗舰版起提供。具体能力和活动价格以 [Apifox 价格页](https://apifox.com/pricing/) 为准。

对这个项目，免费版足够：GitHub Actions 会在 contract 合并后通过开放 API 立即覆盖同步 endpoint 和 schema，并清理不再匹配的资源；已发布文档站会实时反映 Apifox 项目的主分支内容。免费版每 3 小时定时导入可以作为客户端打开时的额外保障；只有必须由 Apifox Runner 独立执行周期拉取时，才需要考虑支持该能力的付费方案。
