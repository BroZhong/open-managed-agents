# OpenAPI 与 Apifox 同步

本项目以 TypeScript OpenAPI 契约生成文档，Hono 负责实际请求处理。同步链路是：

```text
API 路由或模型变更
  -> pnpm openapi:generate
  -> docs/openapi.json
  -> GET /openapi.json
  -> OpenAPI contract CI
  -> GitHub Actions 导入 Apifox
  -> Apifox 已发布的文档站实时展示项目内容
```

此外，工作流会在 Apifox 中确保存在一个指向远端 `/openapi.json`、由自托管 Runner 执行的定时导入设置。该设置启用覆盖和 `deleteUnmatchedResources`，用于清理代码中已经删除、但普通 CLI 导入可能保留的旧资源。

## 本地生成与校验

在仓库根目录运行：

```bash
pnpm openapi:generate
pnpm openapi:check
pnpm --dir server --filter @oma-server/api exec vitest run test/openapi.test.ts
```

`openapi:generate` 会确定性地更新 `docs/openapi.json`。`openapi:check` 不写文件；如果提交的文件落后于 TypeScript 契约，它会失败。契约测试会读取 Hono routers 的实际路由清单，确保 method/path 与 OpenAPI 一一对应。

新增或修改接口时，仍需同步修改 `server/packages/api/src/openapi/` 并提交生成后的 `docs/openapi.json`。目前 handler 校验与 OpenAPI schema 尚未共用同一份 Zod 定义，因此 method/path 漂移能被 CI 自动发现，请求体或响应字段的语义漂移仍需要测试与 code review 约束。

## 提供远端 OpenAPI 服务

服务启动后会公开提供：

```text
GET https://<API 域名>/openapi.json
```

此端点不需要 API key，并返回 `Cache-Control: public, max-age=300`。部署时设置：

```bash
PUBLIC_API_URL=https://api.example.com
```

这样 OpenAPI 的 `servers[0].url` 会指向真实 API 地址。当前 Kubernetes Service 是集群内的 `ClusterIP`；若要让 Apifox 云端从 URL 拉取，还需要配置公网 Ingress、域名和 TLS。不要只暴露文档而意外放开原本受保护的 `/v1/*` 接口。

也可以在 Apifox 中手动用 `https://<API 域名>/openapi.json` 新建定时导入。该 URL 必须能被 Apifox 的导入服务访问；内网服务需要自托管 Runner，或者只使用 CI 文件导入。

参考：[导入设置](https://docs.apifox.com/import-settings)、[Apifox CLI](https://docs.apifox.com/doc-5637756)。

## 一次性配置 Apifox 和 GitHub

1. 登录 [Apifox Web](https://app.apifox.com/)，为本服务创建一个专用 HTTP API 项目。不要在该项目中混放人工维护的其他 API；精确同步会删除远端契约中不存在的资源。
2. 在 Apifox 账户设置中创建 API Access Token，并记下项目 ID。
3. 在“团队资源 -> 通用 Runner”中部署并启动一个自托管 Runner，记下 Runner ID。默认定时导入依赖有人打开 Apifox 项目；指定 Runner 后才能无人值守执行。
4. 在项目的“分享文档 -> 发布文档站”中配置可见性并点击“立即发布”。复制文档站 ID 和公开地址。
5. 在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 中创建 Repository secrets：`APIFOX_ACCESS_TOKEN`、`APIFOX_PROJECT_ID`。
6. 创建 Repository variables：
   - `PUBLIC_API_URL`：部署后的 HTTPS API origin，例如 `https://api.example.com`；不要带 `/openapi.json`。
   - `APIFOX_DOCS_SITE_ID`：上一步已发布文档站的 ID。
   - `APIFOX_DOCS_URL`：可选，已发布站点的完整 HTTPS 地址，用于 Actions summary 显示链接。
   - `APIFOX_RUNNER_ID`：已经部署并启动的通用 Runner ID。
   - `APIFOX_RUNNER_TYPE`：可选；团队 Runner 使用默认值 `TSHGR`，组织 Runner 填 `OSHGR`。
7. 在 API 部署环境中把 `PUBLIC_API_URL` 设置为同一个 origin。
8. 在 `main` 分支手动运行一次 `Sync OpenAPI to Apifox`。以后 API 契约合并到 `main` 且契约 CI 通过后会自动同步。

Apifox CLI 2.2.7 可以创建或更新文档站配置，但没有独立的发布命令；创建配置不等于完成首次公开发布。因此首次“立即发布”保留为 UI 操作，工作流会检查 `publishedAt`，避免把未发布站点误报为可访问页面。已发布站点会实时反映 Apifox 项目内文档的变化。

参考：[发布文档站](https://docs.apifox.com/publish-documentation-site)。

## GitHub Actions 自动同步

`Sync OpenAPI to Apifox` 工作流只接受 `main`：

- 自动运行时，checkout 已通过 `OpenAPI contract` 的准确 commit SHA。
- 手动运行时，也会重新执行生成一致性、Hono route inventory 和 Redocly 校验。
- 使用临时 OpenAPI 文件把 `servers[0].url` 替换为 `PUBLIC_API_URL`，不会修改仓库中的确定性产物。
- 普通 CLI 导入立即更新新增和修改的接口。
- `docs/apifox-auto-import.json` 创建由指定 Runner 执行的远端定时同步，启用覆盖与删除不再匹配的资源；同名配置漂移时会重建。
- 最后检查指定文档站已经发布。

仓库的定时导入配置使用 180 分钟间隔，以兼容当前免费版。付费套餐可调整为更短间隔。Runner 必须保持 Started；离线期间，即时 CLI 导入仍会更新新增和修改，但精确清理会等待 Runner 恢复。

本地手动导入时，不要直接导入仓库中指向 localhost 的 `servers`。可以先生成临时文件：

```bash
jq --arg url "${PUBLIC_API_URL%/}" '.servers[0].url = $url' \
  docs/openapi.json > /tmp/openapi.json

npx --yes apifox-cli@2.2.7 import \
  --project "$APIFOX_PROJECT_ID" \
  --format openapi \
  --file /tmp/openapi.json \
  --access-token "$APIFOX_ACCESS_TOKEN"
```

不要把 Access Token 写入仓库、OpenAPI 文件或 workflow YAML。

## 是否需要付费

截至 2026 年 7 月，Apifox 免费版为 `¥0/席位/年`，包含在线分享 API 文档和定时导入，但免费版定时导入频率是每 3 小时一次。更短的 30/10/5 分钟频率、多个文档站及更细的发布范围属于更高套餐能力；Runner 的可用范围和额度也应以团队当前套餐为准。具体以 [Apifox 价格页](https://apifox.com/pricing/) 为准。

对这个项目，先用免费版即可：GitHub Actions 会在契约合并后立即导入，3 小时定时同步主要负责远端校验和清理已删除资源。若必须让删除接口也在几分钟内从 Apifox 消失，再考虑升级套餐。
