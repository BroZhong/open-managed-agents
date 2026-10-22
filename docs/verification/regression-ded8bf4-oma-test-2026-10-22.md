# oma-test 回归测试：镜像 ded8bf42b530（2026-10-22）

回归对象：phase 2 之后的三个修复。
- `bc43162`：交接截止时被 detach 的 Turn 不再被继续观察，因此不会在 PG pool 关闭后才收尾。
- `ded8bf4`：心跳在 ack 之前停止，避免正常完成后误报租约丢失。
- `4100c35`：内存 store 回滚，不在 oma-test 上运行，所以本次不做线上检查。

只在测试环境进行。数据来自 subagent 的证据目录 `oma-wt/storyboard-20261022/evidence/p3/`，本地私有，不入库；汇总见同目录下的 `REPORT-p3.json`，本文件旁的 JSON 是它的副本。

## 总表

| 段 | 内容 | 结果 |
|---|---|---|
| A | release verifier 全部 11 个阶段，无故障 | 26/26 |
| B | Resumed-Turn verifier：kill、handoff、detach、big ×2、cleanup | 42/42 |
| C | 分镜任务 6 个故障窗口 run + 2 个基线 run | 8/8 产物与恢复契约通过；30 次接管；0 冲突 |
| D | 全窗口 Runner 日志审计（7 个 Pod，含 `--previous` 和已消失的 Pod） | pool-after-end 0 次（phase 2 为 2 次）；PendingLeaseLostError 0 次；ClaimLost 1 次，来自主动终止，符合预期 |
| E | journal flush、心跳 | flush p50 4.9 ms，p99 26.7 ms；≥64 KiB 的 12 次 p50 16.3 ms、p99 50.5 ms；心跳每个输入 34.4 次更新（每 10 s 约 1.10 次） |
| F | 其他租户与清理 | 每次故障前其他租户的活动 Session 都为 0；测试 Session 全部 terminate，key 已吊销 |

## B：Resumed-Turn verifier

| 场景 | 接管 | 结果 |
|---|---|---|
| kill -9 | expired gen2，距故障 30.4 s | 120 s 的 bash 结果为 outcome unknown。模型先检查现场，没有重跑；Sandbox 进程照常跑完，文件内容为 STARTDONE |
| handoff（删 Pod） | released gen2，距故障 12.9 s | 工具在旧 Runner 上跑完，最后一次提交 29 ms 后交接，0 个 unknown |
| detach（删 Pod） | released gen2，距故障 21.7 s | 截止时 detach，结果为 outcome unknown，模型先检查状态；**没有 pool 错误** |
| big ×2 | – | 103,333 B 的 flush 分别用了 50.5 ms 和 37.4 ms |

## C：分镜任务（t0 = 06:04:34.5Z）

| run | 窗口 | 时长 s | 镜头 | 模型请求 | 接管 exp/rel | unknown | 结果 |
|---|---|---:|---:|---:|---:|---:|---|
| 10 | 故障 | 962 | 47 | 95 | 2/5 | 1 | 通过 |
| 11 | 故障 | 702 | 48 | 75 | 2/1 | 0 | 通过 |
| 12 | 故障 | 842 | 47 | 97 | 2/3 | 0 | 通过 |
| 13 | 故障 | 900 | 46 | 100 | 2/4 | 0 | 通过 |
| 14 | 故障 | 755 | 45 | 80 | 2/3 | 0 | 通过 |
| 15 | 故障 | 683 | 46 | 76 | 2/2 | 2 | 通过 |
| 16 | 基线 | 573 | 45 | 72 | 0/0 | 0 | 通过 |
| 17 | 基线 | 614 | 44 | 69 | 0/0 | 0 | 通过 |

| 故障 | 接管 |
|---|---|
| kill -9（目标 Runner 上有 6 个根 Session 和 5 个子 Session） | 12 个 expired，距故障 21.0–31.0 s。其中 10 个由同一个 Pod 重启后的进程接手 |
| 优雅删 Pod | 11 个 released：1 个在请求闸口交接（8.8 s），10 个在截止时交接（21.7–21.9 s），其中 4 个正在运行的 DP 子 Session 被 detach |
| rollout restart | 7 个 released：5 个在 SIGTERM 后 1.0–2.5 s，2 个处于同步等待的根 Session 在截止时（20.0 s） |

多实例检查结果：30 个接管标记中 (turnId, generation) 没有重复；27 个子执行全部 completed；generation 只增不减；pending 没有残留；旧 owner 在接管后没有任何写入。判断依据是 seq，Pod 之间的时钟差约 0.1 s，用时间戳判断会误导。

## 发现

1. **（回归，PR-B 引入，正在修复）Interrupted Turn 总会写一条 `workspace_storage_error`。** 用 oma_test 的历史数据核对：
   - 旧镜像时段：136 个中断 Turn 中只有 1 个有这条错误；
   - PR-A（04 时）：1 个中断，0 个有；
   - PR-B 的三个镜像（09、11、13 时）：每次中断都有。

   直接原因：中断之后，有一次沙箱执行没有拿到退出证据，`SandboxSession` 因此把这个 Turn 标成不确定（`uncertainTurn`）。这带来两个后果：一是用户看到误导性的报错；二是该 Turn 的沙箱活动不会被释放，空闲回收要等到 24 小时上限，而不是 30 分钟。
2. **（信息）主动终止 Session 引起的 ClaimLost 记为 `Runner drain failed`（error 级别）。** 这是设计内行为，但日志级别应该降低。
3. **（信息）event 的 `ts` 取自写入方 Runner 的时钟。** 跨 Runner 时它可能与 seq 顺序倒挂约 0.1 s，排序应以 seq 为准。

## 与 phase 2 对比

| 项 | phase 2（194c53a） | phase 3（ded8bf4） |
|---|---|---|
| pool-after-end 错误 | 2 | 0 |
| 正常完成后的 lease-lost 误报 | 0 | 0 |
| 接管次数 | 19 | 30（另有 B 的 3 次） |
| recovery 错误 | 0 | 0 |
