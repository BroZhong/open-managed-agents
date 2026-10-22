# oma-test 定点回归：镜像 395e30e564f0（2026-10-22）

本次回归针对两个修复：

- `68ecf73`：Interrupt 取消了一个结果已知的 Sandbox 文件操作（tool_use 提交后正在写请求文件）时，不再把 Turn 标成 uncertain。
- `395e30e`：Session 被主动终止后丢失 claim，不再记为 `Runner drain failed`。

测试只在测试环境进行。开始前确认过：没有其他租户的活动 Session，pending 为 0。证据见本文件旁的 JSON；原始日志保存在本地私有目录 `oma-wt/storyboard-20261022/evidence/p4/`。

| 项 | 结果 |
|---|---|
| Interrupt 7 次（5 次立即发出，2 次在 tool_use 之后 5 s 发出），另加完整 verifier 中的 1 次 | 8 个 Interrupted Turn 全部没有 `session.error`。其中 5 次中断落在写请求文件窗口（`This operation was aborted`），3 次走 SIGTERM 路径（`Command aborted`）。Session 空闲后 resource-use 为 0，排在后面的输入都跑完了。phase 3 时，每个 Interrupted Turn 都会带一条 `workspace_storage_error` |
| 完整 release verifier | 26/26。`delegation-async` 首次运行超时：模型在第一个 Turn 内用 `get_subagent_result(wait)` 消费了后台结果，平台行为正确，是 verifier 只认第二个 Turn 那条路径。已修正脚本，现在两条路径都接受，但仍要求结果只被消费一次；修正后在测试服复跑通过 |
| active-terminate | `Runner drain failed` 为 0 条（phase 3 有 1 条 error 级日志）；只剩一条 info 级的 flush 拒写日志 |
| Resumed-Turn：kill / handoff / detach | 接管时间：kill 31.4 s（expired），handoff 12.4 s（released，距最后一次提交 27 ms），detach 21.6–21.8 s（released）。detach 首次运行时，"未重跑"检查误判：模型用 `time.sleep` 轮询来等待仍在运行的原进程，被当成了重跑。已修正脚本，改为只匹配原始那条长命令 |
| 全窗口日志审计（5 个 Pod，含 `--previous`） | 以下全部为 0：`Runner drain failed`、`PendingLeaseLostError`、pool-after-end、error 级 ClaimLost、`workspace_storage_error` / `session.error` |
| journal flush | 共 289 次，p50 4.1 ms，p99 22.1 ms，max 36.3 ms |
| 清理 | 22 个 Session 已 terminate；全局 pending、running、resource-use 均为 0；key 已吊销；Runner 2/2 Ready |
