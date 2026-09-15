# Apifox OpenAPI 覆盖同步调查

调查日期：2026-07-15。

## 2026-09-15 复核补充

下文保留 2026-07-15 的接口选择依据和约束；它描述导入能力及应满足的检查条件，不代表现在线上同步已经通过。

- 官方 [导入接口的机器可读定义](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873.md) 仍包含 `OVERWRITE_EXISTING`、`deleteUnmatchedResources` 和 `prependBasePath`，原方案使用的字段仍有依据。但应读取 schema 的枚举定义；页面的 URL 示例把 `endpointOverwriteBehavior` 写成了不在该枚举内的 `deleteUnmatchedResources`，不能直接照抄这个示例。
- 最近一次 [GitHub 同步运行 34878322577](https://github.com/BroZhong/open-managed-agents/actions/runs/34878322577) 在导入后返回 `schemaFailed=0, schemaIgnored=49`，未通过现有严格计数检查。回读发现这 49 个模型与该提交的契约语义一致，`ignored` 在这里表示未变化。再次实测导入时，54 个接口仅报告 `endpointUpdated=17, endpointIgnored=0`，未变化的接口没有计入任何计数；46 个模型报告 `schemaUpdated=1, schemaIgnored=45`。旧计数条件会误报失败，且无法发现鉴权丢失；应检查报告的失败后再做完整内容回读。
- 初查时 GitHub 与公开站都使用旧 API 地址；现已改为 `https://agentry.welltop.tech/api`，公开索引已回读为 54 个接口、46 个模型，旧 Session messages 项已清除。仓库 URL 校验也已支持路径前缀。
- 进一步官方导出核对发现：导入没有绑定接口的有效鉴权（即使将 global security 展开到 operation，仍然丢失）；multipart 上传的顶层 `anyOf` 被转为空对象。公开 Markdown 的 3.0.1 转换还有额外损失。因此资源数量与导入响应均不能保证文档正确。
- Repository variables 未配置 Runner。当前源码、已部署 API 和 Apifox 发布版本的差异与修复状态见 [审计报告](../api-documentation-audit-2026-09-15.md)；最新操作说明见 [OpenAPI 与 Apifox 同步](../apifox.md)。

## 原调查结论（2026-07-15）

`apifox-cli@2.2.7 import --format openapi` 没有暴露资源冲突策略，因此不能作为“已有接口内容一定更新”的证据。Apifox 官方开放 API 提供了适合 CI 的导入接口：

```text
POST https://api.apifox.com/v1/projects/{projectId}/import-openapi
```

请求支持把 `endpointOverwriteBehavior` 和 `schemaOverwriteBehavior` 都设为 `OVERWRITE_EXISTING`，并可通过 `deleteUnmatchedResources` 清理数据源中已不存在的接口和模型。响应包含 endpoint、schema、两类 folder 的 created/updated/failed/ignored 计数。原调查将 `ignored` 视为失败的条件已由上文实测订正：这些计数只能发现报告的错误，不能代替导出内容比较。[Apifox 开放 API：导入 OpenAPI/Swagger 格式数据](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873)

Apifox 的导入设置文档也把“覆盖已有接口”“智能合并”“不导入”等定义为不同冲突行为，并说明可以删除数据源中已不存在的资源。这与开放 API 的显式枚举语义一致。[Apifox 导入设置](https://docs.apifox.com/import-settings)

OpenAPI 导入涵盖接口、数据模型和环境；`prependBasePath: false` 的官方字段说明明确建议把基础路径保留在环境面板。线上仍应通过环境列表或公开文档页验证 `servers` 对应的前置 URL，因为开放 API 的响应只给资源计数，不返回最终环境内容。[Apifox 导入功能介绍](https://apifox.com/help/api-manage/import-api/intro)、[Apifox 开放 API：导入 OpenAPI/Swagger 格式数据](https://s.apifox.cn/apidoc/docs-site/4478210/api-173409873)

## Runner 边界

绑定数据源的定时导入默认由打开项目且有写权限的客户端或 Web 端触发；自托管 Runner 才能在客户端关闭时按固定间隔独立执行。GitHub Actions 直接调用开放 API 不需要 Runner，Runner 只适合作为额外的周期同步保障。[Apifox 定时导入](https://docs.apifox.com/scheduled-import)、[Apifox 通用 Runner](https://docs.apifox.com/universal-runner)

## 安全约束

- 调用导入 API 前必须核对专用项目 ID、名称和可选团队 ID。
- 非空项目必须已有本服务的 `GET /health` 与 `GET /openapi.json` 哨兵。
- `deleteUnmatchedResources` 会在 API 调用内直接删除，因此必须在调用前分别计算计划删除的 HTTP endpoint 与 schema，并应用 `APIFOX_MAX_ENDPOINT_DELETIONS`、`APIFOX_MAX_SCHEMA_DELETIONS`。
- Access Token 只从 CI secret 读取，固定请求 `https://api.apifox.com`，禁止重定向，不打印请求头或完整失败响应。
- 成功时要求所有已报告的 failed 为零，计数为合法非负整数且不得超过本地资源总数；允许未变化的 schema 被忽略、未变化的 endpoint 不计数。随后必须官方导出 OpenAPI 3.1，核对完整 method/path 和 schema 集合、请求/响应/描述/示例、有效鉴权及环境 URL。仅计数通过不算同步成功。
