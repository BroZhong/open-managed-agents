# Sandbox sweeper 只读报告：正式服与 oma-test（#289）

2026-10-24 04:34Z（12:34 +08）用 `deploy/scripts/run-sandbox-sweep-report.sh` 对正式服和 oma-test 各跑了一次 ADR-0023 sweeper 的只读报告，工具从提交 `b48d05753f5a` 构建。**结论：正式服会删除 10 个 Sandbox，oma-test 会删除 3 个，没有收养、缩短到期或"无到期时间"的删除，每轮删除数都远低于上限 50。两个环境共用一个网关 API key，看到的是同一份 707 个 Sandbox 的列表；按规则，正式服只处理其中 704 个（binding 在 `oma` 中有行），oma-test 只处理 3 个（binding 在 `oma_test` 中有行），两边没有交集，各自把对方的 Sandbox 判为 `unlabelled` 并保留。** 2026-10-24 人工报告中的 10 个正式服孤儿判定为"删除（Session 已全部终止）"，而不是预想的"收养"：这 10 个 Session 在 2026-10-22T16:33:37Z 已经终止，原因见下文。全程只对网关发 `GET /v2/sandboxes`，只对 PostgreSQL 发 SELECT（在 READ ONLY 事务内），没有修改网关、数据库或任何集群资源。

## 要点

1. **正式服的 10 个孤儿应删除，不应收养。** 它们的 binding 行是 `creation_pending = true`、`sandbox_id` 为空，按迁移规则读作 Creating(epoch)，已过截止时间。但 10 个 Session（都是根 Session，没有子 Session）在 2026-10-22T16:33:37Z 全部终止，`session_cleanup` 在 16:35:56–58Z 第一次尝试就记为完成。当时 `claimReclamation` 在 `sandbox_id` 为空时不返回回收凭据，所以终止流程什么都没删，这正是 ADR-0023 "Context" 一节描述的情况。规则表中"B 的所有 Session 都已终止 → 删除 S"一行适用；收养它们之后也不会有人使用。收养路径（Session 仍存活时）由单元测试覆盖。
2. **oma-test 今天又出现了两次同样的问题。** `flg5c`（claim 于 03:19:59Z）和 `kkgcb`（claim 于 04:09:36Z）正在运行，所属 Session 在 claim 后几秒内就终止了（`session_cleanup` 分别在 03:20:01Z 和 04:09:37Z 完成）。binding 停在 `creation_pending = true`，Sandbox 没有被回收。如果不处理，它们会一直运行到 2026-10-25 03:19Z / 04:09Z，暂停后再保留 24 h。两个 oma-test Runner Pod 在 04:01:34Z 和 04:02:30Z 启动，说明测试服上有人在做部署或测试。
3. **环境隔离成立。** 目前所有 Sandbox 都还没有 `oma.dev/environment` 标签（#282 尚未上线），全部按"无标签的旧 Sandbox"处理：只有 binding 在本环境 schema 中有行时才处理。正式服的 3 个 `unlabelled` 正是 oma-test 的 3 个，oma-test 的 704 个 `unlabelled` 正是正式服的 704 个。
4. **正式服没有正在使用或正在运行的 Sandbox。** 正式服的 694 个已记录 Sandbox 都是 Ready(本身)、无人使用、已暂停，规则是保留，由平台在暂停后 24 h 删除。列表中只有 2 个运行中的 Sandbox，都属于 oma-test。没有 Sandbox 缺少到期时间：10-24 人工报告里的 `t5jdf` 已手动删除。
5. **sweeper 以列表为准，不处理没有 Sandbox 的行。** 正式服有 2,597 个 Ready 行，但列表中只有 694 个 Sandbox 被记录，其余约 1,903 行指向已被平台删除的 Sandbox，会在下次使用时被确认不存在并转为 Cold。`oma_test` 有 234 个 Creating 行，其中 231 个没有 Sandbox（主要是 2026-10-21 突发留下的），迁移后第一次使用时会对账为 Cold。这两类都不是 sweeper 的职责。
6. **不要用 `kubectl exec -i` 把程序从 stdin 传进这些 ACS Pod。** 实测 stdin 读到 EOF 之后，进程写到 stdout 的内容会丢失：第一次报告在第 221 行中途截断；一个打印 `a`、等 1.5 s、再打印 `b` 的脚本只收到 `a`。不带 `-i` 时 200 KB 的输出完整到达。所以 wrapper 用 `kubectl cp` 把 bundle 拷进 Pod 里新建的 `/tmp` 目录，在 Pod 内校验 sha256，再不带 `-i` 执行；报告最后一行必须是结束标记，否则 wrapper 失败；退出时（包括失败和 Ctrl-C）删除该目录。所有运行结束后，两个环境全部 5 个 Runner Pod 的 `/tmp` 下都没有残留。

## 方法

- **命令：** `deploy/scripts/run-sandbox-sweep-report.sh production`（namespace `oma-infra`，Pod `oma-runner-756dcc96b6-9jww2`，schema `oma`）和 `… test`（namespace `oma-test`，Pod `oma-runner-58486f89c4-26sq2`，schema `oma_test`）。wrapper 用 esbuild 打包 `server/packages/api/src/sandbox-sweep-report.ts`，传 `--environment` 和 `--schema`；工具检查 `PG_SCHEMA` 与 `--schema` 一致后才运行。
- **网关：** 按 Pod 的 `E2B_API_URL` 和 `X-API-Key: $E2B_API_KEY` 分页请求 `GET /v2/sandboxes?state=running,paused&limit=100`，用响应头 `x-next-token` 作为下一页的 `nextToken`。每次 8 页，139–197 ms。请求不走 HTTP 代理（使用独立的 undici `Agent`）。
- **数据库：** 一个连接，`BEGIN READ ONLY`，`SET LOCAL statement_timeout = '60s'`，最后 ROLLBACK。先通过 `information_schema.columns` 判断 `delegation_environments` 上是 `creation_pending` 还是 `creating_since`（两者同时存在或都不存在时报错）。旧列为 true 时读作 `creating_since = 'epoch'`，与 ADR 的迁移一致。`inUse` 和 `allSessionsTerminated` 与 `PgSandboxLifecycleStore.claimReclamation` 判断"忙"的方式相同：未终止 Session 的 `delegation_resource_uses`，或 binding（`COALESCE(sessions.delegation->>'sandboxSessionId', sessions.id)`）下未终止 Session 的 `pending_events`。没有存活 Session 时，`allSessionsTerminated` 为 true。
- **判定：** `selectSweep`（`server/packages/sandbox/src/sandbox-sweep.ts`），`intentDeadlineSeconds = 180`、`idleSeconds = 1800`、`maxKills = 50`。
- **输出：** 每个 Sandbox 只打印 sandboxId、binding id、环境标签、状态、startedAt、endAt、binding 行的状态、是否被某个 binding 的 `sandbox_id` 记录，以及判定结果。不打印 metadata 的其他内容（`security.agents.kruise.io/storage-auth` 等注解可能含凭证，见 #260、#277），也不打印网关或数据库返回的错误正文。
- **核对：** 另用一个临时的只读脚本（未提交，同样拷进 Pod、在 READ ONLY 事务内执行、执行后删除）读取了 13 个 binding 的 Session 状态、`terminated_at`、`session_cleanup` 和 `pending_events`，结果与报告一致。

## 正式服（schema `oma`，04:34:28Z）

| 项目 | 值 |
|---|---|
| 网关列表 | 707 个（暂停 705，运行 2），8 页，145 ms |
| 环境标签 | 无标签 707 个；binding 在 `oma` 有行的 704 个，无行的 3 个 |
| 被 `oma` 的 binding 记录（`sandbox_id`） | 694 个；无记录 13 个 |
| `oma.delegation_environments` | 5,090 行：Ready 2,597，Creating 10，Cold 2,483，reclaiming 0 |

| 判定 | 原因 | 数量 |
|---|---|---|
| 保留 | paused（Ready 本身，无人使用，已暂停） | 694 |
| 保留 | unlabelled（无标签，binding 不在本环境） | 3 |
| 删除 | terminated（Session 已全部终止） | 10 |

```json
{"msg":"sandbox_sweep","env":"production","orphans":10,"unresolved":0,"unusedRunning":0,"noDeadline":0,"killed":10,"adopted":0}
```

需要处理的和不处理的 Sandbox：

| sandboxId | binding | 状态 | startedAt | endAt | binding 行 | 判定 |
|---|---|---|---|---|---|---|
| sandbox-system--auto-story-v2-rn5bk | sess_i9WRsRRDi8vRAEdbf77WL | paused | 2026-10-22T13:20:10Z | 2026-10-24T13:20:10Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-qbdb2 | sess_NaZ2jGufMrgHXo_da21xC | paused | 2026-10-22T13:20:12Z | 2026-10-24T13:20:12Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-rz86n | sess_KRvkVfvDOG5j8skn3YLWH | paused | 2026-10-22T13:20:13Z | 2026-10-24T13:20:13Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-tr9sh | sess_I36SG95Sz-RAi7M4nrPxt | paused | 2026-10-22T13:20:14Z | 2026-10-24T13:20:14Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-prhng | sess_py__ZDxgp4leLzLe3kjHm | paused | 2026-10-22T13:20:17Z | 2026-10-24T13:20:17Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-x2ql8 | sess_JL0_xdRGyEFpxAYf5wIOL | paused | 2026-10-22T13:20:18Z | 2026-10-24T13:20:18Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-777ns | sess_pS6-g1W9UEtcEv_P8sCoc | paused | 2026-10-22T13:20:20Z | 2026-10-24T13:20:20Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-hhxfs | sess_eaqaCXO1oG1pgfzE6h0fr | paused | 2026-10-22T13:20:22Z | 2026-10-24T13:20:22Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-n84kk | sess_fTMz9rPYNP5TyOOTElRUv | paused | 2026-10-22T13:20:22Z | 2026-10-24T13:20:22Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-k69k8 | sess__cp8voyAk-xQ8eBDQaFNt | paused | 2026-10-22T13:20:24Z | 2026-10-24T13:20:24Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-474fn | sess_hmD5RDLlWWNdU54YRSklp | paused | 2026-10-22T07:58:46Z | 2026-10-24T07:58:46Z | 无（属于 oma-test） | 保留：unlabelled |
| sandbox-system--auto-story-v2-flg5c | sess_OeVU9Ft10PT4PZsNtgiVZ | running | 2026-10-24T03:19:59Z | 2026-10-25T03:19:59Z | 无（属于 oma-test） | 保留：unlabelled |
| sandbox-system--auto-story-v2-kkgcb | sess_gMuvs29OcgFnwTcZYIvhg | running | 2026-10-24T04:09:36Z | 2026-10-25T04:09:36Z | 无（属于 oma-test） | 保留：unlabelled |

那 10 个 Session 都在 2026-10-22T16:33:37.598–.981Z 终止，`session_cleanup` 各尝试 1 次，在 16:35:56–58Z 记为完成，没有 pending event。

其余 694 个"保留：paused"的 Sandbox：claim 时间 2026-10-23T03:54:33Z–14:18:24Z，endAt 2026-10-24T04:41:18Z–14:56:46Z，都被自己 binding 的 `sandbox_id` 记录，都无人使用。

## oma-test（schema `oma_test`，04:34:32Z）

| 项目 | 值 |
|---|---|
| 网关列表 | 同一份 707 个（暂停 705，运行 2），8 页，170 ms |
| 环境标签 | 无标签 707 个；binding 在 `oma_test` 有行的 3 个，无行的 704 个 |
| 被 `oma_test` 的 binding 记录（`sandbox_id`） | 0 个；无记录 707 个 |
| `oma_test.delegation_environments` | 757 行：Ready 12，Creating 234，Cold 511，reclaiming 0 |

| 判定 | 原因 | 数量 |
|---|---|---|
| 保留 | unlabelled（无标签，binding 不在本环境，即正式服的 704 个） | 704 |
| 删除 | terminated（Session 已全部终止） | 3 |

```json
{"msg":"sandbox_sweep","env":"test","orphans":3,"unresolved":0,"unusedRunning":0,"noDeadline":0,"killed":3,"adopted":0}
```

| sandboxId | binding | 状态 | startedAt | endAt | binding 行 | 判定 |
|---|---|---|---|---|---|---|
| sandbox-system--auto-story-v2-474fn | sess_hmD5RDLlWWNdU54YRSklp | paused | 2026-10-22T07:58:46Z | 2026-10-24T07:58:46Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-flg5c | sess_OeVU9Ft10PT4PZsNtgiVZ | running | 2026-10-24T03:19:59Z | 2026-10-25T03:19:59Z | Creating(epoch)，全部终止 | 删除：terminated |
| sandbox-system--auto-story-v2-kkgcb | sess_gMuvs29OcgFnwTcZYIvhg | running | 2026-10-24T04:09:36Z | 2026-10-25T04:09:36Z | Creating(epoch)，全部终止 | 删除：terminated |

这 3 个 Session 的 `session_cleanup` 分别在 2026-10-22T07:58:48Z、2026-10-24T03:20:01Z、04:09:37Z 完成（各 1 次），binding 行都是 `creation_pending = true`、`sandbox_id` 为空，没有 pending event。`oma_test` 中的 12 个 Ready 行，记录的 Sandbox 都已不在列表中。

## 与 2026-10-24 03:10Z 人工报告对比

| 项目 | 人工报告（03:10Z） | 本报告（04:34Z） | 差异原因 |
|---|---|---|---|
| 网关上已 claim 的 Sandbox | 707 | 707（04:15Z 时为 708） | 新增 oma-test 的 `flg5c`、`kkgcb`，同时 2 个正式服的已暂停 Sandbox 到期被平台删除 |
| 被正式服 binding 记录 | 696 | 694 | 那 2 个到期删除的 Sandbox 都已被记录。例如 `hwnf6` 的 endAt 是 04:23:28Z，在 04:22:54Z 的列表中还在，04:26Z 的列表中已经没有 |
| 没有任何 binding 记录 | 11（正式服 10 + oma-test `474fn`） | 13（同样的 11 个 + `flg5c`、`kkgcb`） | oma-test 今天新增了两个同类孤儿，见要点 2 |
| 没有到期时间 | 1（`t5jdf`，已手动删除） | 0 | 一致 |
| 正式服 10 个孤儿的判定 | 预期收养 | 删除：terminated | Session 在 10-22 已全部终止，见要点 1 |

人工报告中的 11 个孤儿都由 binding 标签找到了对应的行：正式服的 10 个在 `oma`，`474fn` 在 `oma_test`。各自只被所属环境处理一次。这 11 个都会在今天到期，由平台删除（`474fn` 在 07:58:46Z，其余 10 个在 13:20:10–13:20:24Z），在此之前启用 sweeper 才会由 sweeper 删除。`flg5c` 和 `kkgcb` 则要到 2026-10-25 才会暂停。

## 网关列表的实际字段

在运行报告之前，04:15Z 用一个只读 GET 在两个环境各检查了一次（只输出字段名和类型、metadata 的键名、state、startedAt 和 endAt，不输出 metadata 的值）。当时列表中有 708 个 Sandbox，其中暂停 706 个、运行 2 个：

- 每个条目都有 `sandboxID`、`templateID`、`clientID`、`alias`、`domain`、`envdVersion`、`state`、`startedAt`、`endAt`（字符串），`cpuCount`、`memoryMB`、`diskSizeMB`（数字），以及 `metadata`（对象）。响应头有 `x-next-token` 和 `x-request-id`。条目按 claim 时间升序排列，与上游 v0.6.0 `list.go` 以 claim 时间注解为排序键一致；两次分页都没有出现重复的 id。
- metadata 的键（708 个条目都有）：`image.alibabacloud.com/enable-image-cache`、`oma.dev/binding`、`oma.dev/tenant`、`oma.dev/workspace`、`sandbox.agents.kruise.io/hash-immutable-part`、`security.agents.kruise.io/agent-name`、`security.agents.kruise.io/storage-auth`、`security.agents.kruise.io/token-status`。还没有 `oma.dev/environment`。
- `endAt` 都可以解析，而且都在未来。运行中的 Sandbox：`endAt − startedAt = 24 h`（创建时设定的到期）。已暂停的：695 个为 24.5–28.2 h，即暂停时刻加上 24 h 保留期；11 个为 48 h，即 10-22 那 11 个跑满 24 h 后才暂停的。所以已暂停 Sandbox 的 endAt 是平台删除它的时间。`startedAt` 都可以解析。
- 没有找到"无到期时间"的样本（`t5jdf` 已删除）。上游 v0.6.0 `convertToE2BSandbox` 用 RFC3339 格式化 `ParseTimeout` 的结果（优先 PauseTime，否则 ShutdownTime），没有到期时间时输出 Go 的零值 `0001-01-01T00:00:00Z`。报告把它，以及任何不晚于 epoch 或无法解析的值，读作 `endAt: null`。e2b SDK 的 `Sandbox.list` 会把它变成公元 1 年的 Date，而不是 null；#291 实现 `SandboxClient` 的列表方法时要做同样的映射。
- 上游的 `setTimeout` 拒绝不在运行状态的 Sandbox（内部判为 409，对外返回 500），对没有到期时间的 Sandbox 直接跳过。这是 `selectSweep` 不缩短、也不因"无到期时间"删除已暂停 Sandbox 的依据之一。
