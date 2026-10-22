# oma-test 分镜长程任务 + Runner 故障注入（2026-10-22）

**结论：9/9 次运行通过产物验收和恢复契约。** 6 次运行在故障窗口内经历了 kill -9 和优雅删 Pod，共 19 次接管（10 expired + 9 released）。整个过程没有 recovery 错误，没有重复执行，多个 Runner 实例之间没有冲突。另外发现 1 个低严重度问题：优雅关停时，被 detach 的 Turn 要等 PG pool 关闭之后才收尾。

**环境：**
- 镜像：phase 1 为 `oma-server:b8c1d8de1b7b`，phase 2 为 `194c53a81800`。
- Runner：2 副本，RollingUpdate（maxSurge 1 / maxUnavailable 0），开启 shareProcessNamespace。
- 测试 Agent 与 10-21 相同：`agent_MQphuTegkqyda82d_elSj`，FreeCanvas，`deepseek/deepseek-flash`，thinking high。Sandbox 模板为 `oma-scale-test-20261021`，业务凭证已清空。
- 工作负载：剧本 EP29，Director → DP → Formatter 三个同步子 Agent，目标 40–50 镜、11 列 `storyboard-dp.csv`。
- 证据：本文件旁的 JSON；原始日志与采样在本地私有目录 `oma-wt/storyboard-20261022/`，不入库。

## 1. 每次运行

| run | 窗口 | 根 Session | 时长 s | 镜头 | 子/执行 | 模型请求 | 工具调用 | 接管 exp/rel | outcome unknown | 产物 | 恢复契约 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 01 | smoke（旧镜像） | sess_aMRk1BQP128qb3PklclHV | 609 | 47 | 3/3 | 81 | 97 | 0/0 | 0 | 通过 | 通过 |
| 02 | 故障窗口 | sess_0rR1QgQFieErBHnuNyS9V | 601 | 48 | 3/3 | 67 | 91 | 0/2 | 0 | 通过 | 通过 |
| 03 | 故障窗口 | sess_cb3amDE6pi9eNoTK3RqAv | 847 | 44 | 3/3 | 102 | 118 | 2/2 | 0 | 通过 | 通过 |
| 04 | 故障窗口 | sess_SnVVXTQTRWZHcyBnzF4-Z | 669 | 47 | 3/3 | 88 | 104 | 2/1 | 1 | 通过 | 通过 |
| 05 | 故障窗口 | sess_EeW7ycS4c9n_A_ye4RjVK | 667 | 48 | 3/3 | 77 | 96 | 2/1 | 0 | 通过 | 通过 |
| 06 | 故障窗口 | sess_BlCdmLnLnVE7BL-YzPeQx | 720 | 47 | 3/3 | 91 | 110 | 2/1 | 0 | 通过 | 通过 |
| 07 | 故障窗口 | sess_qvVoln706DhymxE7G4ifM | 705 | 46 | 3/3 | 83 | 103 | 2/2 | 0 | 通过 | 通过 |
| 08 | 基线 | sess_fCr6brqfQX4x_QWbiidHV | 610 | 48 | 3/3 | 80 | 104 | 0/0 | 0 | 通过 | 通过 |
| 09 | 基线 | sess_VysycfgrK8Kx7J2RKeZeA | 667 | 48 | 3/3 | 67 | 90 | 0/0 | 0 | 通过 | 通过 |

- **时长对比：** 基线均值 629 s，故障窗口均值 702 s。故障窗口是 6 路并发，基线是 2 路，所以两者的差值不全是故障造成的。
- **产物验收**（方法与 10-21 相同）：
  - `storyboard-dp.csv` 的 11 列表头完全一致；镜头数在 40–50 之间，镜头号唯一，时长为正整数，镜头参数为三段；Skill 校验器报 0 个错误。
  - `result.json` 与持久化状态一致。
  - 每个 run 都是 3 个同步子 Session，串行执行，没有嵌套委派。
  - 各 run 的 CSV hash 互不相同，没有子 Session 被多个 run 共享，新文件都只写在各自的 `outputs/lh-20261022-NN/` 下。
- **恢复契约**（根 Session 和子 Session 都检查）：
  - 每个输入恰好一个 `session.turn_completed`，pending 全部确认；
  - `session.error` / `session.turn_aborted` 为 0；
  - 每个 tool_use 恰好一个结果；
  - 每次 Agent 调用只对应一次委派执行。

## 2. 故障与接管

t0 = 03:02:24.777Z。

| 时间 (UTC) | 动作 | 目标 Runner | 当时在该 Runner 上的 Session | 接管 | 距故障 |
|---|---|---|---|---|---|
| 03:06:27.700 | kill -9（node pid 52） | ktfcg | run 03–07 的根 Session（同步等待中），以及这 5 个 run 的 Director | 10 个，全部 expired、generation 2，由 wtf7m 接手 | 24.7–29.8 s（租约 30 s） |
| 03:10:54.851 | 优雅删 Pod | wtf7m | run 02–07 的根 Session，以及 run02 的 Formatter、run03 的 DP、run07 的 DP | 9 个，全部 released，由重启后的 ktfcg 接手 | 见下方说明 |
| 03:15:24.860 | rollout restart | kkjdp、ktfcg 依次收到 SIGTERM | kkjdp 上没有测试 Session；ktfcg 上 run03 根 Session 的最后一次模型请求正在进行 | 0 个：run03 在旧 Runner 上于 03:17:01.513 完成 | – |
| – | 第二次 kill -9（可选） | – | 跳过：此时 02–07 已经全部 idle | – | – |

优雅删 Pod 那一次的接管时间：
- Formatter 6.3 s，距旧 owner 最后一次写入只有 28 ms。
- 其余 8 个是 21.7–21.8 s，即 SIGTERM 加上 20 s 截止时间。

**接管的代价：**
- 根 Session 的接管标记各带 1 个 dangling，就是那次同步 Agent 等待。等待在新 owner 上恢复，子执行完成后由 `delegation_result_*` 回填结果，没有重复建子 Session。
- 子 Session 的 9 次接管中，8 次 dangling=0，代价只是重发一次模型请求。

**outcome unknown 只出现 1 次**，在 run04 的 Director（`sess_qNrRwF9OfFrIS2ODTO3lZ`，seq 100）：
- 一条写 `/tmp/build_dn.py` 的 bash 调用已经提交，696 ms 后 Runner 被 kill。
- 接管后模型先检查现场：`ls` 发现输出目录为空，脚本文件却已有 29,521 字节，说明原命令执行到了一半。
- 它随后运行这个脚本，遇到 SyntaxError，就用 write 重写了脚本。
- 原调用没有被重复执行。

**重复的 bash 命令有 3 处，都是模型自己的选择，不是系统重放：**
- run03 Director 的 validator：第一次的结果在 kill 之前已经提交，接管后模型又跑了一次。
- run08 有 2 处，期间没有发生任何接管。

**其他租户：** 每次故障前都用只读 SQL 查过，非测试的活动 Session 为 0。窗口内也没有非测试 Session 以 recovery 错误结束。

## 3. 多实例冲突检查

| 检查 | 结果 |
|---|---|
| 每个 pending 输入同一时刻只有一个 owner | 是。采样了 23 个 Session，owner 每次变化都伴随 generation 升高 |
| claim generation 只增不减 | 0 次下降 |
| 同一 generation 不会被接管两次 | 19 个标记，没有重复的 (turnId, generation) |
| 委派执行由单一 owner 持有 | 27 个执行全部 completed，每个执行只有一个 owner；执行的 generation 等于子 Session 最后一个标记的 generation；每个 callerToolUseId 只有 1 个执行 |
| 接管后旧 owner 不再写入 | 0 次（按 Runner 日志逐个 Session 核对） |
| ClaimLost / LeaseLost / write-fence 拒绝 / PG 错误 / flush 错误 | 0 / 0 / 0 / 0 / 0 |
| `Runner drain failed` | 2 次，原因见第 5 节第 1 条 |
| Runner 重启与就绪 | ktfcg 因 kill 重启 1 次（exit 137），约 20 s 后 Ready；其他 Pod 没有重启；结束时 2/2 Ready |

Journal flush 共 2,376 次：p50 5.0 ms，p90 13.7 ms，p99 36.3 ms，max 663.6 ms。最大值出现在 ktfcg 刚接管 9 个 Turn 的时候。

## 4. DB 负载（11:02:05–11:30:46 CST，1,720 s）

这个窗口内只有本测试在写事件。

| 表 | Δins | Δupd | Δdel | Δseq_scan |
|---|---:|---:|---:|---:|
| pending_events | 32 | 1,090（全部 HOT） | 32 | 18,050 |
| events | 3,873 | 0 | 0 | 6 |
| event_counters | 32 | 3,873 | 0 | 0 |
| sessions | 27 | 150 | 0 | 12 |
| delegation_executions | 24 | 104 | 0 | 0 |

- **心跳更新：** 32 个输入合计被持有 10,076 s，平均每个输入 34.1 次更新，即每 10 s 约 1.08 次。多出来的部分来自认领、接管和释放。修复前测得的长期平均约为 350 次/输入。
- **`pending_events` seq_scan：** 约 10.5 次/s。这些主要是写入 fence 自身的查询，不是轮询：每次持久写入（共 3,873 次）都要按 Session 加锁读一次 claim，每次 Sandbox 操作也要校验一次所有权。这张表只有几十行，planner 因此选择 seq scan。这部分开销随实际工作量增长，不随 Runner 实例数增长。这一归因来自 schema 和代码，没有看过执行计划，因为 RPC 路径不支持 EXPLAIN。

## 5. 问题与观察

1. **（低）被 detach 的 Turn 在 PG pool 关闭后才收尾。**
   - 现象：wtf7m 优雅关停时，run03 的 DP（`sess_VDF5wvQTsKN7mIRQNicSd`，标记 seq 168）和 run07 的 DP（`sess_KD6ANNCd46SuwRwuvVF68`，标记 seq 112）在截止时间被 detach。之后 `finishSettledActivity → releaseResourceUse` 直到 pool 已经 `end()` 才执行，日志报了 2 次 `Runner drain failed: Cannot use a pool after calling end on the pool`。
   - 影响：没有功能影响。新 owner 以 generation 2 重写了这两行，两个 DP 都正常完成，结束时 resource-use 为 0 行。但每个在截止时间被 detach、且带 Sandbox 活动的 Turn，都会留下一条假的 error 日志。
   - 处理：已修复（被 detach 的 attempt 不再观察 Sandbox 活动，由下一个 owner 的 generation 接替，ADR-0019），并补了回归测试 `F2 a Turn detached at the deadline leaves its Sandbox activity…`。
2. **（信息）同步等待或长模型请求要到 20 s 截止才交接。** 这与 ADR-0021 一致：Pi 只在下一次模型请求前停下。滚动发布时，这类 Turn 会多等约 20 s。
3. **（信息）子 Session 不一定跟随父 Session 所在的 Runner。** kill 之后，DP 子 Session 落在 ktfcg，父 Session 在 wtf7m。
4. **（信息）Sandbox 都在 10–15 s 内可用，没有出现约 110 s 的冷启动或创建限流。** 原因没有核实，测试边界不允许读取 sandbox-system。

## 6. 清理

- 36 个测试 Session（9 个根、27 个子）已 terminate。
- pending=0，running/waiting=0，resource-use=0，9 个根 Sandbox 绑定已清空。
- 临时 API key `apikey_d35-mwlEl-kIX-oBRicNb` 已吊销，之后的 GET 返回 401。
- Runner 2/2 Ready（`194c53a81800`）。
