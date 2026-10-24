# steer_subagent 指令在后续请求中持续可见：oma-test 验收

状态：oma-test 验收通过，生产未发布。记录于 2026-10-24，时间均为 Asia/Shanghai。对应 PR #279（`cfcddc4`）。

## 部署

- 镜像：`oma-server:cfcddc4a49da`（`sha256:e300fa55d549…`）。用 git bundle 传到 vfs-dev，在独立 worktree `/tmp/oma-build-cfcddc4a49da` 中构建，复用了上一版的层缓存。
- 预检：`oma_test` 中没有非 idle/terminated 的 Session，`pending_events` 为 0。
- oma-test：`render.mjs test cfcddc4a49da cfcddc4a49da 740ac31d0ceb`。`kubectl diff` 只有 oma-api 和 oma-runner 两处镜像变化。apply 后两者都滚动完成，`/api/health` 返回 ok。
- 回滚：`oma-server:faebb32f2e3c`。

## 新旧镜像对照

同一个脚本：本 PR 修改后的 `verify-durable-delegations.mjs`，依次运行 `init`、`steer-start`、`steer-finish`。验证租户 `steer-verify-20261024`，真实模型 `openai-codex/gpt-5.6-sol`。

子 Agent 先执行 `sleep 90`，父 Agent 在 sleep 期间调用 `steer_subagent`。新指令要求：先运行 `printf %s $RANDOM`，再用另一次 bash echo 这个数，最后才写入 `STEERED_<runId>`。写入依赖之前一次调用的输出，所以一定发生在指令首次送达之后的第二次或更晚的模型请求里。

| | 旧镜像 `faebb32f2e3c`（`release-1792814224421`） | 新镜像 `cfcddc4a49da`（`release-1792814602002`） |
| --- | --- | --- |
| 指令送达后的工具调用 | `printf %s $RANDOM`，下一次请求直接给出一首与任务无关的俳句并结束 | `printf` → `echo 3529` → 写入 → `cmp`/`od` 校验 → 最终回答 `STEERED_…` |
| 送达后各次请求的 inputTokens | 6744 → 6703。新增了一次调用和结果，总量反而下降，说明指令已不在上下文中 | 6796 → 6936 → 6992 → 7386 → 7964，单调增长 |
| `steered file bytes` | 失败：文件不存在（404），新旧 token 都没写 | 通过 |
| 全部检查 | 在 `steered file bytes` 处中止 | 17/17 |

两次运行里，steer command 都是 `applied`，execution 都是 `completed`，结果通知都是 `processed`。旧镜像的 durable 记录同样完整，所以界面和回放看不出问题，只有子 Agent 的行为暴露了它。修改前的 steer 阶段允许子 Agent 在首次看到指令的那一次请求里完成写入，因此测不出这个 bug。

## 回归

- **回归脚本** `verify-api-runner-release.mjs`：init、basic、real-start、real-finish、interrupt、delegation-sync、delegation-async、loop、terminate、active-terminate、cleanup 共 26 项检查，全部通过。验证租户 `split-release-1792814827391`；cleanup 终止了全部验证 Session，临时 API key 均已撤销。
- 两个验证租户的 Session 都已通过各自脚本的 `cleanup` 终止。
- **日志**：发布后到验收结束，两个 Runner 和 API 都没有 error、exception 或 failed。

## 未验证

以下路径只有 Adapter SDK 测试覆盖，线上没有专门构造：

- 重试、compaction 之后的请求能否拿到新指令；
- 多条指令同时送达；
- 指令在子 Agent 生成最终回答期间到达。
