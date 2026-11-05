# Runner 自动扩缩容 oma-test 验收（#333，V1–V14 与 2000 个真实 Session 压测）

2026-11-05 01:53–03:50（Asia/Shanghai；带 Z 的时间为 UTC）。分支 `feat/runner-autoscaling`（#323–#332，ADR-0026、ADR-0027）发布到 oma-test：KEDA 读 API 内部需求接口来驱动 Runner，并在 V1–V14 上逐项验收，最后跑了 2000 个真实 Session。

除 oma-test 外，只在 kube-system 重启过 ack-keda（V9）。压测期间对生产只读：RDS、NAT 指标和生产 Pod 日志。

**结论：V1–V14 全部通过。** 两轮各 2000 个真实 Session（纯文本、每个执行一次 bash）全部成功，0 个 `session.error`，0 个"结果未知"。所有护栏都没有触发。没有需要单独开 issue 的未通过项；§7 记录了几项运维事实。

## 1. 发布

| 步骤 | 时间 | 结果 |
|---|---|---|
| 阶段 A 镜像 | 01:39 构建 | `oma-server:202611050139`（`sha256:16b069c4…`，git `11cafe08`，代码评审修复之前） |
| Secret / last-applied | 01:53 | `oma-runner-demand` 由 `openssl rand -hex 32` 生成。`drop-runner-replicas.sh oma-test` 去掉了 last-applied 里的 `replicas`，Pod 数不变 |
| apply | 01:53–01:55 | render → `kubectl diff` → apply：ConfigMap 加了 `RUNNER_CAPACITY`/`SHUTDOWN_GRACE_MS`，API 和 Runner 换镜像并加了 env，新建 ScaledObject 和 TriggerAuthentication。apply 后 Runner 副本数仍是 2，HPA 显示 `0/40` |
| 迁移 0031 演练 | 01:56:48 完成 | 旧 Runner 全部退出后，在 `oma_test` 上依次执行删表 → 核对 → 回滚（`oma_test_app` 恢复 SELECT/UPDATE）→ 再删表，最终状态是已删。`oma.delegation_lock` 没有动 |
| 阶段 B 镜像（评审修复） | 02:36 构建，02:44:39 滚动发布 | `oma-server:202611050236`（`sha256:4dcd4486…`，git `758aa405`）。这次滚动发布本身用来验收 V5/V6/V7/V12 和 #331（§3） |

回滚目标：

| Deployment | 镜像 |
|---|---|
| oma-api | `sha256:af4bb67f…` |
| oma-runner | `sha256:52d00f65…`（`codex/sandbox-control-observability`，df9cf9b7。发布前确认 Runner 已一小时没有活动） |
| oma-web、oma-image-builder | 不变 |

回滚时先执行 0031 的回滚 SQL，再启动旧镜像。

需求接口在集群内的检查（loadgen Pod）：

| 请求 | 结果 |
|---|---|
| 带 token | 200 `{"demand":0,"executing":0,"syncWaiting":0,"ready":0,…}` |
| 不带 token、token 错误 | 401 |
| `/api/internal/runner-demand` | 404 |
| 公网 `https://agentry-test.welltop.tech/internal/runner-demand` | 由 oma-web 返回 SPA HTML，访问不到接口 |

## 2. 验收矩阵

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| V1 | 单个 Runner 收到大量顶层 Session | ✅ | V8 的 200 个突发中，2 个 Runner 都正好持有 50 个活租约，其余 100 个排队。V3 开始时也是每个 50、排队 100。纯文本 2000 期间，任何时刻每个 Pod 的顶层执行数都 ≤ 50 |
| V2 | 2000 个真实 Session 突发 | ✅ | §4。副本从 2 扩到 48，因为需求峰值约 1900，按 C=40 只需要 48 个。新 Pod 在进程启动约 1.5 s 后领到第一条输入，比 Kubernetes 标记 Ready 还早 9–15 s。两轮都是 2000/2000，0 报错 |
| V3 | max=3 满载，父 Session 同步等子 Agent | ✅ | 200 个父 Session，每个同步等一个纯文本子 Agent。200/200 父 Session 输出 `PARENT_DONE`，200/200 个执行 `completed`，0 报错，没有死锁。从提交到完成 p50 13.9 s、max 24.2 s。子 Session 让单个 Runner 一度持有 100 个领取（顶层 50 + 子 Session），符合"子 Session 总是领取、计入执行数" |
| V4 | 第 5 个并发子 Agent | ✅ | 见 V10。拒绝时的工具错误原文是 "This Session already has 4 unfinished subagents, its limit. Wait for one of them to finish (get_subagent_result with wait=true), then call Agent again."。父 Turn 继续运行并输出 `PARENT_DONE`。子 Agent 结束后，同一父 Session 再次调用被接受（queued） |
| V5 | bash 运行 10 分钟期间缩容 | ✅ | 4 个 `sleep 600`，§3 |
| V6 | 同步等子 Agent 期间缩容 | ✅ | 3 个父 Session，§3 |
| V7 | 模型流式输出期间缩容 | ✅ | 3 个，§3 |
| V8 | 指标接口失败 | ✅ | §5 |
| V9 | 重启 KEDA operator 和 metrics apiserver | ✅ | 纯文本 2000 的峰值（02:58:11–02:58:57）重启两者，副本数一直保持 39，HPA 随后照常读需求 |
| V10 | 同一父 Session 并行多个 `Agent`；多个家族同时运行 | ✅ | 20 个父 Session 各在一次回复里并行发起 6 个后台 `Agent`。每个父 Session 正好 4 个执行；共 80 个接受、40 个拒绝（每个父 Session 2 个）。PG 锁等待采样（500 ms 间隔，240 s）见 §6 |
| V11 | 50 个副本空闲 | ✅ | 50 个空闲 Runner：`oma_test` 表扫描 124 次/s、写 0 次/s，RDS CPU 0.8–1%。advisory lock 只有一个持有者（`oma-sandbox-sweeper oma-runner-68954c5886-sjhxd`） |
| V12 | 长交接期下滚动更新 | ✅ | §3。滚动期间在飞的 70 个 Turn 全部完成，0 报错 |
| V13 | 手动干预 | ✅ | §5 |
| V14 | ACS 长终止宽限与退出期间的探针 | ✅ | 2026-11-04 实测（ADR-0026）。本次也看到：旧 Pod 进入 Terminating 后 readiness 变为 false 但继续运行，`x2dnc` 收到 SIGTERM 后 10 分钟才退出 |

## 3. 滚动发布中的交接（#331、V5/V6/V7/V12）

02:44:39 apply 阶段 B 镜像。当时在飞的 Turn：

| 类型 | 数量 | 内容 |
|---|---|---|
| 长 bash | 4 | `sleep 600`，其中 2 个是 9 分钟前启动的 |
| 同步等待 | 3 | 父 Session 的子 Agent 正在执行 `sleep 300` |
| 流式输出 | 3 | 先输出 800/1500 行，再调一次 bash，再请求一次模型 |
| 纯文本 | 60 | 普通 Turn |

`maxSurge` 25% 加 `maxUnavailable` 0 时，新 Pod Ready 之后旧 Pod 才收到 SIGTERM：`x2dnc` 在 02:45:37，`dfvlf` 在约 02:46:24。

- **V6**：`x2dnc` 上同步等待的父 Session，02:45:59 已经在新 Pod `5h9kf` 上（claim generation 2）。`dfvlf` 收到 SIGTERM 后，它上面的 2 个父 Session 立即转到 `5h9kf`，`dfvlf` 随即退出（约 02:46:50）。3 个父 Session 都在新持有者上消费了子 Agent 的结果，输出 `PARENT_DONE` + `CHILD_DONE`。3 个子 Session 的 bash 在旧 Pod 上跑完，同样在下一次模型请求前交接。
- **V5**：例如 `…pRyjkT`，bash 结果 `BASH_DONE` 于 18:48:08.319Z 在旧 Pod 上提交，18:48:08.359Z 新持有者记录 `session.turn_resumed`（generation 2），之后完成。最后一个 bash 约 02:55 结束，`x2dnc` 于 02:55:42 退出，距 SIGTERM 约 10 分钟。4 个都完成，0 个"结果未知"。
- **V7**：2 个流式 Turn 在旧 Pod 上输出完、执行完 `printf STEP2`，在下一次模型请求前交接（generation 2），输出 `STREAM_DONE`。第 3 个在 SIGTERM 前已完成。
- **V12**：上面 70 个 Turn 全部 `idle`，0 个 `session.error`，0 个工具错误，0 个"结果未知"。

## 4. 2000 个真实 Session 压测（V2）

两轮都在集群内的 loadgen Pod 里同时创建 2000 个 Session，再同时各发一条消息。Agent 用 `deepseek/deepseek-flash`、thinking off。开始时 Runner 副本数都是 2。

| | 纯文本 | 每个一次 bash（`sleep 20; printf CAP_OK`） |
|---|---|---|
| 提交 | 02:56:41（创建 9.0 s、发消息 6.2 s） | 03:11:39（9.3 s、6.3 s） |
| 期望副本数 | 3→13→23→33→39，在 +2/7/24/41/52 s | 12→22→32→42→48，在 +1/12/29/46/58 s |
| Ready ≥ 10 / 20 / 30 / 40 | +58 / +69 / +98 s / — | +46 / +58 / +75 / +118 s |
| 队列清空 | 约 +90 s | 约 +110 s |
| 最后一个 Turn 完成 | 02:59:34（约 3 min） | 03:16:37（约 5 min） |
| 结果 | 2000/2000 `turn_completed`，0 个 `session.error` | 2000/2000 的 bash 结果为 `CAP_OK`、`isError=false`，0 个工具错误，0 个 `session.error` |
| 沙箱 | 不使用 | 约 110 s 内 2000 个 Sandbox 全部创建（含预热池共 2009 个）。最慢的几个准备了 3–4 min，没有失败 |
| 峰值活租约 | 1063 个，分布在 23 个 Pod | 1843 个，分布在 37 个 Pod |
| 每个 Pod 处理的 Session 数（min / 中位 / max） | 37 / 67 / 259 | 44 / 50 / 99 |
| 新 Pod 的第一条领取 | — | 比 Kubernetes Ready 早 9–15 s，比进程开始监听晚 1.5 s 以内（n=25） |

各 Pod 处理的 Session 数不同，是因为早起的 Pod 领了不止一轮。领取通过 Runner Capacity 分摊：任何时刻都没有 Pod 超过 50 个顶层执行，每个 Pod 的领取都是在名额空出时发生的。2026-11-04 的压测里两个 Runner 分到 151/49、289/111，那种偏斜不再出现。

第二轮的 48 个 Pod 中有 11 个 Ready 时队列已经清空，没有领到任务。短任务让需求下降得比扩容还快，这些 Pod 在 600 s 窗口结束后每分钟缩 2 个（§5）。

bash 那一轮没有复现 11-04 的挂载失败。当时 400 个里有 25% 失败，原因是单个 Runner 有约 270 个 Sandbox 同时排在 e2b 的 100 个控制连接上。现在每个 Runner 最多 50 个。

## 5. 扩缩容控制（V8、V13、#332）

**V8，指标失败。**

- 02:05:12 突发 200 个纯文本 Session：02:05:29 需求 100/40，期望 5 个副本；02:06:13 5/5 Ready。205 个 Turn 全部完成，0 报错。
- 02:06:46 把 `oma-api` 缩到 0。02:07:10 ScaledObject `Fallback=True`，KEDA 报的值等于目标值，期望副本数等于当前副本数。
- 02:20:59，也就是 API 停止 14 分钟、远超 600 s 窗口之后，副本数仍是 5。
- 02:22:00 恢复 API，02:22:14 指标恢复为 0、Fallback 解除。02:32:04 缩到 3，02:33:00 缩到 2，符合 600 s 窗口加每分钟 2 个。

**V13，手动干预。**

| 操作 | 时间 | 结果 |
|---|---|---|
| min 2 → 4 | 01:58:46 | 立即生效，01:59:48 4/4 Ready |
| apply 渲染清单 | 02:00:02 | Deployment generation（46）不变，没有新的 ReplicaSet，副本数没有被重置 |
| `paused-replicas=3` | 02:33:29 | 立即变为 3、Paused=True，HPA 被移除；去掉注解后 16 s 回到 2 |
| min=4 时加 `paused-scale-in=true`，再把 min 改成 2 | 02:34:29 起 | 90 s 内保持 4，HPA scaleDown `selectPolicy: Disabled`；去掉注解后 11 s 缩到 2 |

那次 apply 同时把 min 改回 2，6 s 内 HPA 从 4 缩到 2（"All metrics below target"），这是 HPA 的语义，见 §7。

**#332，需求回到 0、副本数回到 2。**

- 第二轮压测后：03:16:37 需求为 0。03:23:12 窗口结束，开始缩容（48→46），之后每分钟缩 2 个，03:46:57 回到 2 个副本。46 个 Pod 用了 23.8 min，平均每分钟 1.94 个。
- V8 的 5 → 2 也是同样的路径。

## 6. 数据库与护栏

**护栏**：采样 43 次，每 30 s 一次，覆盖两轮压测。

| 指标 | 峰值 | 说明 |
|---|---|---|
| RDS CPU | 13.2%（bash 那一轮结束时） | 阈值 70% |
| RDS 连接使用率 | 8.4% | |
| 生产 API 和 Runner 的错误日志 | 0 行 | |
| NAT EIP 出口 | 107.7 Mbps，仅 19:01Z 一分钟 | 在两轮压测之间的 V11 空闲期，测试本身没有流量；其余时间 ≤ 17 Mbps。阈值 170 Mbps |

**PG 负载**：`pg_stat_user_tables` 中 `oma_test` 的增量，包含观察脚本自己的查询。

| 场景 | 表扫描/s 峰值 | 写/s 峰值 | 活跃期平均 |
|---|---|---|---|
| 纯文本 2000 | 15138 | 2171 | 扫描 5556，写 464 |
| bash 2000 | 14162 | 1948 | 扫描 3763，写 477 |
| 50 个空闲 Runner（停掉观察脚本后） | 124 | 0 | |

**家族锁（V10）**：在 20 个家族各并发发起 6 次 `Agent` 的 240 s 内，每 500 ms 采一次 `oma_test_app` 的锁等待，共 478 次。只有 9 次采到等待：

- 14 次等在 advisory lock 上，都是 `pg_advisory_xact_lock(…'/delegation_family/'…)`，即同一个父 Session 的并发调用按设计排队；
- 4 次是 `pending_events` 行锁上的 transactionid 等待；
- 最长 67.7 ms。

没有采到跨家族的排队。

### 6.1 同步等待的父 Session 与 Runner 内存

03:48 在 2 个 Runner 上同时提交 100 个父 Session，每个同步等一个执行 `sleep 180` 的子 Agent，17 s 内 100 个全部进入同步等待。

| Runner | 持有的 Turn | 内存（node 进程 VmRSS） |
|---|---|---|
| `wt7fd` | 49 个同步等待 + 5 个执行中的子 Session | 246 MB → 374–379 MB |
| `sjhxd` | 51 个同步等待 + 95 个执行中的子 Session | 432 MB → 470 MB（之前那次突发的内存被 GC 回收，读数不可靠） |

据 `wt7fd` 推算，每个同步等待的父 Session 约占 2.7 MB，这是上限，因为包含了那 5 个子 Session。按生产峰值 63 个同步等待计，约 170 MB，相对每个 Runner 的 8 GiB 可以忽略。

100 个父 Session 全部输出 `PARENT_DONE`，0 报错。另外，100 个子 Session 有 95 个落在 `sjhxd`：子 Session 不受 N 限制，被赢得 wake 的那个 Runner 领走，所以它们不参与按名额的分摊（§7.3）。

## 7. 运维事实

1. **降低 min 会立即缩容。** HPA 的 600 s 缩容窗口只作用于由指标得出的建议值，min 本身不在窗口内，所以只受每分钟 2 个的策略限制（V13）。缩容走 ADR-0021 的交接，是安全的。
2. **KEDA fallback 在第 4 次连续失败时生效。** KEDA 的判断是 `failures > failureThreshold`。在那之前 HPA 拿不到指标，保持当前副本数。ADR-0026 已注明。
3. **Child Session 可以让单个 Runner 超过 N，而且不被分摊。** V10 中观察到一个 Runner 持有 57 个，V3 中 100 个，§6.1 中一个 Runner 执行 95 个子 Session。这是"Child Session 总是领取"的设计，用来避免死锁，代价是子 Session 集中到赢得 wake 的 Runner 上。目前的负载下（每个父 Session 最多 4 个子 Session，生产峰值 141 个 Turn）不是问题；如果以后子 Session 的负载变重，再考虑分摊。
4. **扩容可能偏多。** 短任务时副本数会多于实际需要（第二轮 11 个 Pod 没有领到任务），由 600 s 窗口之后的缩容回收。

## 8. 数据与清理

原始数据在本机 `/tmp/oma-as-accept/`，不进仓库：

- 采样：`k8s-*.jsonl`、`observe-v2a.jsonl`、`observe-v2b.jsonl`、`guard.jsonl`
- Runner 日志：`runner-logs/`、`runner-logs-v2b/`
- 每一批 Session 的提交记录：`v2a-local.json`、`v2b-local.json`
- loadgen Pod 里 `/work/` 下的每批记录和锁采样

### 8.1 清理（03:52）

- **Session**：测试租户 `autoscale-202611050201` 的 4986 个 Session（含 Child Session）全部 DELETE，都返回 200，状态 `terminated`，没有剩余的 pending 输入。
- **Agent 和 Key**：3 个测试 Agent 已删除。临时 API Key `apikey_sLpCUlvX4xERdmcA2qWek` 已吊销，再用它请求返回 401；本机凭据文件已删除。
- **Pod 和采样**：loadgen Pod 已删除，本机采样脚本已停止。
- **Sandbox**：测试 Sandbox 全部回收，只剩各 Warm Pool 的预热实例（`oma-test-sandbox` 1 个，生产 `oma-sandbox` 8 个）。
- **KEDA**：ScaledObject 恢复为 min 2、max 50，没有 pause 注解。
- **保留**：测试租户里已终止的 Session 和事件保留作审计。oma-test 继续运行阶段 B 镜像和 KEDA，这是第二阶段的目标状态。
