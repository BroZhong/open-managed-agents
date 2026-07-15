# Apifox OpenAPI 覆盖同步调查

调查日期：2026-07-15。

## 结论

`apifox-cli@2.2.7 import --format openapi` 没有暴露资源冲突策略，因此不能作为“已有接口内容一定更新”的证据。Apifox 官方开放 API 提供了适合 CI 的导入接口：

```text
POST https://api.apifox.com/v1/projects/{projectId}/import-openapi
```

请求支持把 `endpointOverwriteBehavior` 和 `schemaOverwriteBehavior` 都设为 `OVERWRITE_EXISTING`，并可通过 `deleteUnmatchedResources` 清理数据源中已不存在的接口和模型。响应包含 endpoint、schema、两类 folder 的 created/updated/failed/ignored 计数，可以让 CI 拒绝“已有资源被忽略”的假成功。[Apifox 开放 API：导入 OpenAPI/Swagger 格式数据](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873)

Apifox 的导入设置文档也把“覆盖已有接口”“智能合并”“不导入”等定义为不同冲突行为，并说明可以删除数据源中已不存在的资源。这与开放 API 的显式枚举语义一致。[Apifox 导入设置](https://docs.apifox.com/import-settings)

OpenAPI 导入涵盖接口、数据模型和环境；`prependBasePath: false` 的官方字段说明明确建议把基础路径保留在环境面板。线上仍应通过环境列表或公开文档页验证 `servers` 对应的前置 URL，因为开放 API 的响应只给资源计数，不返回最终环境内容。[Apifox 导入功能介绍](https://apifox.com/help/api-manage/import-api/intro)、[Apifox 开放 API：导入 OpenAPI/Swagger 格式数据](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873)

## Runner 边界

绑定数据源的定时导入默认由打开项目且有写权限的客户端或 Web 端触发；自托管 Runner 才能在客户端关闭时按固定间隔独立执行。GitHub Actions 直接调用开放 API 不需要 Runner，Runner 只适合作为额外的周期同步保障。[Apifox 定时导入](https://docs.apifox.com/scheduled-import)、[Apifox 通用 Runner](https://docs.apifox.com/universal-runner)

## 安全约束

- 调用导入 API 前必须核对专用项目 ID、名称和可选团队 ID。
- 非空项目必须已有本服务的 `GET /health` 与 `GET /openapi.json` 哨兵。
- `deleteUnmatchedResources` 会在 API 调用内直接删除，因此必须在调用前分别计算计划删除的 HTTP endpoint 与 schema，并应用 `APIFOX_MAX_ENDPOINT_DELETIONS`、`APIFOX_MAX_SCHEMA_DELETIONS`。
- Access Token 只从 CI secret 读取，固定请求 `https://api.apifox.com`，禁止重定向，不打印请求头或完整失败响应。
- 成功时要求 endpoint/schema 的 `created + updated` 分别等于本地 operation/schema 数，endpoint/schema 的 failed/ignored 均为零，folder failed 为零；随后再次读取远端 endpoint 并断言 method/path 集合完全一致。
