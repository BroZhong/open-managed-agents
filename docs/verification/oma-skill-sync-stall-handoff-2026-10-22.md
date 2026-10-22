# Skills 重复同步导致 Child Session 长时间停在准备阶段

状态：已定位重复同步路径，未实施修复或部署。记录于 2026-10-22，时间均为 Asia/Shanghai。关联 #218；本记录是正式服 300 个真实拆分镜任务的性能问题交接，不替代最终压测验收。

## 问题与可复核样本

主 Agent 已将 Skills 同步到 Sandbox，Child Session 共享该 Sandbox，却在每个新 Turn 再次全量同步。父任务因此长期显示 waiting，子任务显示 running，但还没有进入模型和分镜执行。

- 主 Session：https://agentry.welltop.tech/sessions/sess_Rslfm9JNlYgZ-HIrX7Zxy （批次 prod300_20261022，run-233）。
- Child Session：https://agentry.welltop.tech/sessions/sess_9lgFZz6ieC_eMeFYLtkWR （Stage 1 / Director）。
- Delegation Execution：`deleg_sWjq0IkQKKDj1rHGE6EIo`，同步调用。
- 22:05:10.097 子任务持久化 `session.status_running`；截至约 22:39，只有 `delegation.input` 和该状态两条事件，没有模型或工具事件。
- 已有有效 Runner claim，心跳持续续租。不是无人领取。
- Sandbox `sandbox-system--auto-story-v2-8njvb` 已绑定，creation_pending=false，Kubernetes Running / Ready。不是等待首次创建。
- 22:39:26 和 22:39:56 只读检查 `/skills`：`dp-to-shots_canvas-free` 文件数由 3 增至 4，最后修改时间为 22:39:43；后一帧共有 12 个目录、195 个文件。说明准备阶段仍在写入 Skills，并非正在思考但界面漏显示。

## 批次范围内的影响

22:37 左右的只读快照显示：146 个活跃子 Session 最新事件仍为 `session.status_running`，最久约 43 分钟；这一统计不能证明全部卡在完全相同的调用位置。

同一批次已记录 87 次 Supabase Storage `544 DatabaseTimeout`（44 次 list、43 次 getObject），另有 10 次滚动期间的创建状态不确定错误。87 次是错误事件数，不是 87 个最终失败主任务；该样本子任务当时还未报错。Storage 超时与重复读取放大同时出现，但尚未量化 Storage 读取、Sandbox 写入、锁等待各自耗时，也未唯一确定 Storage 内部超时原因。

先前的独立只读 Storage 压测也复现过 HTTP 544，见 `docs/verification/skill-storage-local-concurrency-2026-10-22.md`；它是相关证据，不应直接等同于此次故障的内部根因。

## 已核对的代码路径

核对的是当时生产镜像版本 `626cf65b3c08`，不是仅凭本地工作区版本推测：

1. `server/packages/session-router/src/session-router.ts`：先将 Session 标为 running 并 flush，然后取得 equippedSkills，调用 `sandbox.prepare(...)`，准备后才装配并执行 Adapter。Child Session 同样经过此路径，使用父 Session 的 Sandbox binding。
2. `server/packages/sandbox/src/sandbox-manager.ts`：`prepare()` 将 prepared 清零；`prepareExisting()` 校验环境，列举已有 `/skills`，删除已有与目标 Skill 目录，然后 `projectAll()`。
3. `server/packages/sandbox/src/provision-source.ts`：`S3ProvisionSource.project()` 调用 `skills.getAll()`，再逐个写入 Sandbox。
4. `server/packages/store/src/s3/skill-artifact-store.ts`：`getAll()` 先递归 list，再分批读取文件；底层 `supabase-storage.ts` 请求 Supabase Storage。

没有按同一 Sandbox 已安装的 Skills 内容版本跳过重复同步。每 Turn 刷新最新 Skills 的策略让主任务→Director→DP→Formatter 在内容未变化时也重复搬运。Supabase Skills 存储与 OSS Workspace 存储是不同路径，不能把这里的 544 直接称为 Workspace 文件丢失。

## 建议修复方向（尚未定案）

- 按 Sandbox 实例与有效 Skills 清单/内容版本复用准备结果；版本相同不重复全量下载或写入。不能只用进程内 prepared 标志，否则跨 Runner 和滚动后仍会重复。
- 明确内容修改、装备/卸载、Sandbox 重建、准备中断时的失效规则。不能简单永久跳过全部 Child Session 的准备。
- 同一 Sandbox 的共享任务协调安装；准备结果只在完整成功后发布，不能让任务读到删除一半或安装一半的目录，也不能删掉其他正在执行任务依赖的文件。
- 为准备阶段补充分段耗时和明确的状态/进度，区分等待调度、同步 Skills、模型执行；设置准备总预算和可诊断错误，避免长期只显示 running。
- 对总并发与重复读取进行限流/合并，避免失败重试进一步放大 Storage 压力。具体缓存/同步方案需评审。

ADR-0019 要求每 Turn 验证环境与刷新 Skills；如改为“验证 Skills 版本，变化时更新”，需同步澄清该契约，保留挂载校验及有限生命周期要求。

## 建议验证

- 同一父任务与三个串行子任务使用未变化 Skills：仅首次安装内容，后续不全量重传。
- 跨 Runner 接管、并发共享 Sandbox、Skills 内容/装备变更、Sandbox 重建、同步中断：版本有效且不会使用半成品。
- 存储变慢或返回 544：有界失败并显示具体阶段，不无限显示运行中；避免自动重放不确定的业务工具调用。
- 先用小规模可控复现测量 GET/LIST 次数、写入文件/字节数、准备 p50/p95 与首个模型事件延迟，再评估是否需要重跑大规模负载。不要仅以 HTTP health 正常作为通过。

## 证据位置与交接边界

私有原始证据位于 `/private/tmp/oma-prod300-20261022/`：`wait-diagnosis.json`、`example-skills-progress.json`、两个样本 Session 的 `probe-*.json`、`samples.jsonl`。临时目录不保证长期保留；本记录保存了关键事实，不公开业务正文、凭证或完整私有日志。

本次只读诊断，没有中断该 Session、重启 Runner、修改生产配置或清理 Sandbox。后续 agent 应先重新取当前状态；上述数字是带时间的历史快照。
