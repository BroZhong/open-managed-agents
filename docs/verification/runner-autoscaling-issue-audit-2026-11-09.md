# 扩容遗留 issue 复核（2026-11-09）

核对对象：#322、#323、#333、#336、#337、#346–#349。远端 main 仍为 `3a1e0100aa59e918cf6e1c7f54e914101f49990a`，正式服与测试服 API/Runner 均使用该提交构建的 server digest `sha256:a44550a793fc3ebd75807ca9efa1ecd8867a0800d26a279c23a71913c3c81483`。本轮补做一个真实模型请求、数据库并发回归及只读配置检查，没有重复 2000 并发压测，也没有修改 issue 状态。

## 逐项结论

| Issue | 结论 | 验证与剩余工作 |
|---|---|---|
| #337 清理扫描持事务 | **修复已验证** | 两连接真实 PostgreSQL 的并发清理回归通过；修复前代码在相同测试中连接借用超时。新增测试应随验证记录提交。 |
| #347 模型错误与最终结果统计 | **统计验收要求已满足，可关闭** | 重新核对 11 月 6 日保存的 outcomes/audit/model-errors 与 #333 报告：尝试、受影响/恢复 Session、错误分类及最终结果均分开记录。不应把该 issue 解释为必须消除所有上游错误；无法确定的归因保留为未知。严格 V2 的“没有报错”条件未通过，最终 Turn 成功状态不变。 |
| #346 thinking off | **未解决，重新复现** | API 读回 off，实际 context_start 为 minimal；同版本 Pi 的请求序列化发送 enabled/low。 |
| #348 缩零与 V2 口径 | **机制已确认，验收收尾未完成** | 测试服仍 min=0、cooldown=600。新请求成功触发 0→1；缩零速率的文档例外、V2 起始数/持续需求/空队列判定尚未补齐。生产 min=1 避开缩零路径，但不解决测试服此项。 |
| #336 告警 | **未找到完成证据** | 全集群 PrometheusRule 为 0；CMS 的 17 条指标规则未匹配 OMA/KEDA/Runner，事件规则为 0。仓库和 issue 未记录指定通道、四项规则或各自触发验证。此检查不能排除其他未纳入记录的外部告警系统。 |
| #323 ADR 审阅 | **文档完成，审阅记录未完成** | 两份 ADR、domain 索引、ADR-0010 修订标记及术语均存在；ADR-0026/0027 状态仍为 Proposed，issue 中未找到原文确认。部署授权不替代这条文档验收。 |
| #333 完整验收 | **仍未完整通过** | 历史 V2 严格标准有偏差；本轮确认共享 RDS `pg_stat_statements.track=none`，SQL 语句数/秒仍缺测。表扫描数不是 SQL 语句数。#346、#348、#349 尚未完成。 |
| #349 云 API / Endpoint Warning | **未证实解决** | 本次发布仅扩到 10，不能代表此前 50 Runner 的复验；最新 400 Sandbox 波次仍有 86 个 Pod 的 218 条 Throttling.Api 事件。该证据属于 Sandbox，不能等同于复现 Runner Endpoint 问题。具体受限 API/额度、nodeName/Endpoint 时序及恢复延迟尚未定位。 |
| #322 总任务 | **暂不结项** | 核心功能已经生产生效，生产下限 1；完整验收与 ADR 审阅未完成，生产配置 PR #351 仍为未合并草稿。#336/#337/#338 原本属于总任务范围外的后续项，不作为其额外阻塞条件。 |

## #337 的正反验证

在 vfs-dev 的独立 PostgreSQL 17 测试容器上运行，每次由测试 harness 创建、销毁独立 `oma_harness_*` schema，不连接生产 RDS。新增 `server/packages/store/test/session-cleanup-pool.test.ts`：

- 池大小 2，4 个并行 sweeper 处理 6 条清理记录；外部回调刻意等待，随后从相同连接池查询。
- 等待外部调用时，可同时进入超过 2 个回调，池无连接排队；没有相关 idle-in-transaction，另一个连接可用 `FOR UPDATE NOWAIT` 锁住全部清理行。
- 全部清理恰好成功一次，已完成记录不再执行。
- main 实现通过；对照 #350 前的实现失败：并行回调停在 2，嵌套连接借用超时。对照文件已删除，没有修改待测 main 的产品实现。
- Store 真实 PostgreSQL 全套：**347 passed，3 skipped**。这 3 个 fake-clock 测试随后以 pg-mem 独立执行，**3 passed**。Store TypeScript 检查通过。

## #346 的真实请求与序列化

22:42:08（北京时间）在 oma-test 创建隔离临时租户、Agent 和一个无 Sandbox 的 Session，要求仅回复 `RELEASE_CAP_OK`。API 接收与读回的 thinking 均为 off。

- KEDA 22:42:14 将 Runner 从 0 扩为 1；Pod 于 22:43:01 Ready。
- 持久 `agent.context_start` 在 22:43:00.748 记录 `pi@0.83.0`、`deepseek/deepseek-flash`、`thinking: minimal`。
- Session 正常完成，0 个模型失败尝试，0 个 Turn 错误，收到指定回执。
- 使用相同模型目录与 Pi 版本拦截请求序列化：`clampThinkingLevel(off)=minimal`，请求为 `thinking.type=enabled`、`reasoning_effort=low`。该步骤使用假的 fetch，不额外发送模型请求。
- 临时 Session 已终止、Workspace/Agent 已删除、Key 已撤销并验证 401；active/pending/unsettled 均为 0，验证 Pod 已删除。Runner 交由原有 KEDA 冷却策略回收。

## #347 的统计与判定

复核本机保存的 `text.outcomes.json`、`bash.outcomes.json`、两轮 audit 和 `bash.model-errors.json`，与 [#333 的 11 月 6 日报告](https://github.com/BroZhong/open-managed-agents/issues/333) 一致：

| 指标 | 纯文本 | 一次短 bash |
|---|---:|---:|
| 最终正常完成、含 CAP_OK | 2000 | 2000 |
| assistant 尝试总数 | 2718 | 4068 |
| 失败尝试 | 718 | 68 |
| 受影响且恢复的去重 Session | 654 | 66 |
| 模型文本 terminated | 443 | 0 |
| Request timed out | 245 | 0 |
| Connection error | 30 | 0 |
| HTTP 503 / Service is too busy | 0 | 68 |
| Turn 中止 / session.error | 0 / 0 | 0 / 0 |

503 响应报告服务繁忙；其他类别的现有证据不能区分上游、网络和 Runner。模型文本 terminated 不能算作 Turn 中止。按 #322 仍保留的严格“没有报错”文字，这两轮不满足该子条件，不能因重试恢复而写作零错误；正常完成的 Turn 仍保留成功结果。这满足 #347 的统计与判定要求，但不等于 #333 全部通过或相关故障已消失。

## #348 的控制器边界

[KEDA 2.21 官方说明](https://keda.sh/docs/2.21/reference/scaledobject-spec/#cooldownperiod) 明确 cooldownPeriod 管理缩至 0，1 到 N 的调整由 HPA 处理。因此测试服历史 37→0/42→0 的事件与当前配置一致，HPA 每分钟减 2 不约束该直接缩零路径。生产 min=1、未设置 idleReplicaCount，不走此路径；此前生产实测 10→8→6→4→2→1 已记录。

本轮只验证新需求从 0 唤起并正常完成，没有重做大规模缩零试验。要关闭 #348，仍需将允许直接缩零的范围及修订后的 V2 判定写入正式验收文档，并保留持续需求足以扩至 50 的覆盖。

## 证据位置

本机 `/tmp/oma-production-release-20261109/`：`remaining-issues-audit.json`、`oma-issue337-positive.log`、`oma-issue337-negative.log`、`oma-issue337-store-pg.log`、`issue337-memory-typecheck.log`、`issue346-live.json`、`oma-issue346-serialization.json`、`issue-audit-*-events*.json`、`issue-audit-*-scaler.json`、`cloud-alert-rules.json`、`cloud-event-alert-rules.json`。

历史压测证据位于 `/private/tmp/oma-v2-20261106.nvWfTU/`。这些临时文件不作为长期归档承诺；上述结论、关键数字及测试源码随本报告保存在仓库工作区。
