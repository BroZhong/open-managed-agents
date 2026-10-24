# Runner 信号频道拆分与 Delta 合并：oma-test 验收

状态：oma-test 验收通过，生产未发布。记录于 2026-10-24，时间均为 Asia/Shanghai。对应 PR #276（`9917c00` 频道拆分，`faebb32` Delta 合并）。

## 背景

2026-10-23 对生产 Runner `oma-runner-756dcc96b6-tcv2m` 抓取了 60 秒 V8 CPU profile。当时进程占 0.82 核，主线程 65% 忙。按主线程忙时计：

- 每个 Delta 的 Redis 处理约占 24%：XADD Lua 7.3%，PUBLISH 6.4%，接收全集群 chunk 广播 6.4%，处理回包 3.8%。
- 线上 chunk 平均只有 2.4 个字符。

pi-ai 对流式工具参数逐 chunk 重新解析（24.5%）不在本次范围内。

## 部署

- 镜像：`oma-server:faebb32f2e3c`。在 vfs-dev 的独立 worktree `/tmp/oma-build-faebb32` 中构建，复用了上一版的层缓存。
- oma-test：`render.mjs test faebb32f2e3c faebb32f2e3c 740ac31d0ceb`。`kubectl diff` 只有 oma-api 和 oma-runner 两处镜像变化。apply 后两者都滚动完成，`/api/health` 返回 ok。

## 结果

- **频道订阅**：`PUBSUB NUMSUB` 显示 `oma:oma_test:session-control` 有 2 个订阅者（两个 Runner），`session-output` 有 1 个（API），旧频道 `session-signals` 为 0。
- **回归脚本** `verify-api-runner-release.mjs`：init、basic、real-start、real-finish、interrupt、delegation-sync、delegation-async、loop、terminate、active-terminate、cleanup 共 26 项检查，全部通过。验证租户 `split-release-1792811754700`；cleanup 终止了全部 11 个验证 Session，临时 API key 均已撤销。
- **唤醒**：从 API 接受输入到 SSE 收到 `session.status_running` 用了 23–24 ms，说明 wake 走的是控制频道，没有退回到 5 秒一次的 PG 扫描。
- **Interrupt**：一个 Turn 从开始运行到 `turn_aborted` 共 3.7 秒，其中包括模型调用和启动工具。远低于 10 秒的心跳兜底，说明 check 信号通过控制频道到达。
- **内容一致性**：真实模型的一个 Turn 依次输出 thinking、一次 8,177 字符的 `write` 和正文。
  - 工具参数的实时 Delta 拼接后与最终 arguments 逐字一致。
  - 正文 2 个 block 都逐字一致。
  - 每个 Delta 都带 `deltaId`，且 `turnId:deltaId` 不重复。
  - 没有 `session.error` 或 `turn_aborted`。
- **合并比例**：该 Turn 的 `turn_journal_flush` 日志合计 `deltasIn` 6,572、`deltasOut` 528，合并 12.45 倍。SSE 上无 seq 的帧恰好也是 528 个。合并后平均每帧：工具参数 17 字符，thinking 41 字符，正文 13 字符。
- **日志**：发布后 60 分钟内，两个 Runner 和 API 都没有 error、exception 或 failed。

## 已有差异（与本次改动无关）

thinking 的实时 Delta 拼接后，比持久化的 thinking 多一个结尾的 `"\n\n"`。

原因在 pi-ai 0.83 的 `openai-responses-shared.js`：每个 reasoning summary part 结束时会发出一个 `"\n\n"` delta，而最终 thinking 是用 `summary.map(s => s.text).join("\n\n")` 拼出来的，末尾没有分隔符。

合并只是把 pi-ai 发出的 delta 原样拼接。另外，Complete Event 会替换掉对应的 Delta，所以界面最终显示的是持久化内容，不受影响。

## 未验证

- oma-test 负载很低，测不出 CPU 变化。Runner CPU 和 Redis CPU 要到生产发布后，用同样的 profile 方法和 `kubectl top` 对比。
- 生产滚动发布期间新旧版本的频道不一致：在 API 和 Runner 都换成新镜像之前，旧 Runner 上的 Session 没有实时 token，持久事件依靠 2 秒一次的 PG 补读；发给旧 Runner 的输入要等最多 5 秒的 PG 扫描。建议先发 API，紧接着发 Runner，尽量缩短这个窗口。
