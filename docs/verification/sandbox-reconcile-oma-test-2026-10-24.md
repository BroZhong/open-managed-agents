# ADR-0023 oma-test 发布与验收（#292）

2026-10-24 09:10–10:40Z 在 oma-test 上线 ADR-0023（Sandbox binding 按网关对账），并做了三轮并发突发、一次创建中 `kill -9` 和 sweeper 观察。**结论：#292 的验收项全部通过。** 200 个 Session 同时开始并在创建期间滚动重启 Runner：200 个 Turn 全部完成，每个都用上了自己的 Sandbox，没有 binding 过了截止时间仍停在"创建中"，没有 Turn 以 `sandbox_unavailable` 结束。创建进行中 `kill -9` Runner 后，接管方在意图写入后 182.8 s 收养了被杀 Runner 已经建好的同一个 Sandbox，并继续执行工具。加压到 400 个 Session 时，账号的 ACS 按量 vCPU 配额（2000）被打满，网关有约 13 分钟建不出 Sandbox；即便如此，400 个 Turn 全部完成，399 个用上了 Sandbox，没有 binding 卡住，只有 1 个 Turn 在配额耗尽期间如实以 `sandbox_unavailable` 结束。清理 801 个测试 Session 后，网关上没有它们留下的 Sandbox。

证据：[`sandbox-reconcile-oma-test-2026-10-24.json`](sandbox-reconcile-oma-test-2026-10-24.json)（各轮 SUMMARY 与检查结果；完整 evidence JSON 留在操作者本地 `~/oma-292/`）。工具：`deploy/scripts/run-sandbox-reconcile-acceptance.sh`、`deploy/scripts/verify-sandbox-reconcile.mjs`、`deploy/scripts/run-sandbox-sweep-report.sh`，流程见 `deploy/README.md`。

## 发布

| 步骤 | 结果 |
|---|---|
| 测试环境独立网关 key（#283） | 已于 05:00Z 完成；oma-test 列表只含自己的 Sandbox |
| 只读报告（发布前） | oma-test 列表 1 个 Sandbox，无动作 |
| Runner 缩到 0，`migration pre` | 无活 claim；234 行 `creation_pending = true` |
| 迁移 0024、0025（以 `supabase_admin` 执行，`execute_sql` 内原子） | 234 行变为 Creating(epoch)；旧列已删除；新增 `state_since`、`last_error_*` |
| 镜像 | 先 `32a073309ac1`（冒烟），后 `afcea76b87ed`（含代码评审修复），均在 vfs-dev 构建；配置差异只有 `OMA_ENVIRONMENT=test` 替换 `E2B_REQUEST_TIMEOUT_MS` |
| `migration post` / `after-sweep` | 通过；234 行 epoch 意图全部被 sweeper 或首次使用对账完毕，过截止时间的"创建中"为 0 |
| 冒烟 | 单个 Turn 一次 bash，写 Workspace 并读到 `fuse.ossfs`；新 Sandbox 带 `oma.dev/environment=test` |

回滚镜像记录在操作者本地 `rollback-images.txt`（`oma-server:cfcddc4a49da`），回滚 SQL 为 `0025_*.rollback.sql`、`0024_*.rollback.sql`。

## 突发测试

测试 Agent 使用独立模板 `oma-scale-test-20261021`（5 个预热副本），`sandbox.env` 清空业务凭证，提示词要求一次 bash 写入并回显标记。每轮在约四分之一 binding 进入"创建中"时执行 `kubectl rollout restart deploy/oma-runner`。

| 轮次 | 模型 | Session | 完成 | 用上 Sandbox | 带标记回答 | 过截止仍创建中 | 以 `sandbox_unavailable` 结束 | 接管 |
|---|---|---|---|---|---|---|---|---|
| 1 | `openai-codex/gpt-5.6-sol` | 200 | 200 | 41 | 41 | 0 | 0 | 0 |
| 2 | `deepseek/deepseek-flash` | 200 | 200 | **200** | **200** | **0** | **0** | 25 个 Session，30 次 |
| 3 | `deepseek/deepseek-flash` | 400 | 400 | 399 | 398 | **0** | 1（配额耗尽） | 101 个 Session，189 次 |

- **第 1 轮无效。** 模型网关在 3 s 内对 159 个请求返回 429 `gateway_queue_full`，这些 Turn 以 `pi_agent_error` 结束，根本没有走到 Sandbox。到达工具的 41 个全部正常。之后改用 `deepseek-flash`，与 10-21、10-22 两次 200 路测试一致。
- **第 2 轮（验收轮）。** 准备耗时（`span.sandbox_prepare_*`，ready）p50 42.6 s、p95 66.3 s、最大 106.5 s；binding 从"创建中"到 Ready 的采样 p50 44.8 s、p95 69.9 s。接管的 25 个 Session 中有 24 个发生在首次使用 Sandbox 之前，13 次准备因所在尝试被接管而记为 `aborted`。11 个 Session 在 10:10:12Z 同时遇到一次挂载校验失败（`reason: mount`，约 38 s），作为工具错误返回，模型重试后 6–7 s 内全部恢复，没有 Turn 因此失败（原因未查，见"遗留"）。
- **第 3 轮（加压）。** 10:22–10:33Z 间 `sandbox-system` 的 Pod 报 `ResourceQuotaExceeded: q_resquota-on-demand-vcpu-count hard(2k) used(2000750m)`：前两轮留下的 Sandbox（结束后 30 分钟才暂停）加上本轮 400 个，打满了账号的按量 vCPU 配额。期间创建表现为结果不明（5xx/超时），工具调用按设计等到截止时间、对账、最多再建一次：90 次环境工具错误分布在 89 个 Session，270 次准备重试，准备耗时 p95 309 s。终止前两轮的 Session 释放配额后，挂起的创建恢复。唯一失败的 `sess_53wRfjbPK01LwdZGD_ZHJ` 两次工具调用分别等了 420 s 和 360 s 仍建不出，模型放弃，Turn 结束时记 `session.error{sandbox_unavailable}`，binding 回到 Cold（未卡住），Session API 报 `unavailable` 及 `last_error`。这正是 ADR 描述的"网关不可用时"的行为，不计为验收失败。正式服在此期间没有任何事件，未受影响。
- 每轮提交 400 个输入用时 0.7 s（p95 201 ms），API 不是瓶颈。

## 创建中 `kill -9`

测试模板临时缩到 0 个副本（经维护者同意），使创建走冷启动；kill 之后立即恢复为 5。

| 时刻（UTC） | 事件 |
|---|---|
| 10:15:22.928 | 写入创建意图；被杀 Runner 发出 claim，网关此刻 claim 了 `oma-scale-test-20261021-fn729` |
| 10:15:36.230 | `kill -9` 该 Runner 的 node 进程（binding 仍为"创建中"，已核实） |
| 10:16:02.507 | 租约过期，另一 Runner 接管（`turn_resumed: expired`），旧准备记 `aborted` |
| 10:18:22.9 | 截止时间到，接管方对账：按 `oma.dev/binding` 只查到 `fn729`，收养 |
| 10:18:25.763 | 工具执行成功（意图后 182.8 s，接管后 143.3 s），Turn 正常结束并带标记 |

网关上该 binding 只有 `fn729` 一个 Sandbox，没有重复创建。这正是 2026-10-22 生产事故的场景：旧代码会让这个 binding 永远停在 `creation_pending`。

## sweeper

- 每台 Runner 周期运行：同一 Pod 相邻两轮间隔 9.9 min、11.2 min（10 min ± 2 min 抖动）。
- 10:27:59 一轮（第 3 轮配额耗尽期间）：列出 556 个，清理 34 个已过截止时间且网关上没有 Sandbox 的意图（`expired 34, cleared 34`），缩短 1 个无人使用的 Sandbox 到 30 分钟。
- 清理之后的只读报告（10:36）：网关列表 2 个（两个冒烟 Session，已暂停），计划计数全为 0；随后两台 Runner 在 10:39 的两轮 `listed 2`，全部计数为 0，与报告一致。三轮测试 Session 在报告中都没有 `kill`/`adopt` 行。
- 迁移留下的 234 行 Creating(epoch) 已全部对账（`creating_epoch 0`）。

## 清理

`cleanup` 终止三轮共 801 个 Session：`session_cleanup` 全部完成，binding 全部清空。终止按 binding 回收，`sandbox-system` 回到预热池的规模（`auto-story-v2` 10 个、测试模板 5 个运行中）。每个阶段使用的临时 API key 都在阶段结束时吊销。

## 遗留

1. **ACS 按量 vCPU 配额（2000）与正式服共用。** 400 路突发叠加前一轮尚未暂停的 Sandbox 就能打满。正式服大批量（如 prod300）同样会撞上这个上限；ADR-0023 把全局创建闸门和预热池扩容列为下一步，配额也应一并评估。
2. **第 2 轮 10:10:12Z 的同步挂载校验失败**：11 个 Session 同时失败约 38 s 后恢复，时间点在滚动重启期间。新语义下只是一次可重试的工具错误，但原因（Host 侧 OSS 回读、CSI 挂载或代理）尚未查明。
3. **模型网关并发**：`gpt-5.6-sol` 对 200 路同时请求返回 429。这不是 OMA 的问题，但大批量任务需要考虑模型侧排队。
4. 正式服发布（#293）尚未进行：需 Runner 缩到 0、对 `oma` 执行 0024 与 0025、换镜像，并设置 `OMA_ENVIRONMENT=production`（已在清单中）。
