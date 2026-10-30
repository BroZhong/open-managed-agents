# ADR-0025 oma-test 验收：1C4G Sandbox、空闲 15 分钟后删除

2026-10-30（时间均为 UTC）。分支 `feat/sandbox-1c4g-kill-on-idle`（`049811d2`，ADR 修订 `8a1f4a3b`、`ebe63674`）发布到 oma-test，用 #312 的 Finalcut 回归（AutoShort 第 6 步，EP23）在 1 vCPU / 4 GiB 上跑一遍，再验证空闲删除、下一个 Turn 重新领取和终止回收。只改动了 `oma-test` 命名空间、`oma-test-sandbox` 池和测试 Tenant 的 Workspace 前缀；生产没有改动，也没有读取生产 Workspace。

**结论：全部验收项通过。** Finalcut 545 s 完成，没有 OOM、没有重启，产物与 2C4G 基线逐帧一致；Sandbox 在最后一个 Turn 结束 15 分钟后被删除，不是暂停；下一个 Turn 先 `deferred`，第一次工具调用从 Warm Pool 领取（380 ms）。另外发现两处与预期不同，已改：ACS 的临时存储下限是 30 GiB（不是 15 GiB），网关会给每个领取的 Sandbox 写 `reserve-paused-sandbox-duration: forever`。

## 1. 发布

| 步骤 | 时间 | 结果 |
|---|---|---|
| 池模板 | 09:44:06Z | `kubectl patch sandboxset oma-test-sandbox --type=json`：`containers[0].resources` 改为 requests = limits = 1 CPU / 4Gi、临时存储 15Gi，删除 `spec.persistentContents`（先 `--dry-run=server`）。新池 Pod `alibabacloud.com/pod-use-spec=1-4Gi`（CSI sidecar 的 500m/1Gi 仍不计入） |
| 构建 | 09:58Z | vfs-dev `~/workspace/yuzhong/oma-env-049811d2`（git bundle），复制 `oma-env-0b97e879` 的 `.buildx-cache`，`bash build.sh --push server`，约 1 分钟。`oma-server:202610301758` = `sha256:6d5823b163d3a92d23b4981db92a93ad64dc8dd2e47731aab0ef4df6a8ad015a` |
| 应用 | 09:59:18Z → 10:01:01Z | `render.mjs test`（web 不变 `b0d6399e…`）。`kubectl diff` 只有 oma-api、oma-runner、oma-image-builder 的镜像各一行；用旧镜像渲染的回滚清单与线上 diff 为空。发布前 `oma_test` 没有未完成的 Environment 构建、没有运行中的 Session。`/api/health` = ok，新 Pod 日志只有既有的 Deprecation/EnvHttpProxyAgent 警告 |
| 池临时存储 | 10:28Z | 发现 ACS 把 15Gi 提到 30Gi（§4）后，池模板改为 30Gi，清单同步 |

**回滚**：

```bash
export KUBECONFIG=~/.kube/agent-platform-config
node deploy/scripts/render.mjs test \
  sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d \
  sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d \
  sha256:b0d6399ef708f813d823cb2ee7e34ef230d1a568f1e56bcfdeeeedcd991258f7 \
  sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d > /tmp/oma-test-rollback.yaml
kubectl apply -f /tmp/oma-test-rollback.yaml
kubectl -n sandbox-system patch sandboxset oma-test-sandbox --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/resources","value":{"limits":{"cpu":"2","memory":"4Gi"},"requests":{"cpu":"2","ephemeral-storage":"50Gi","memory":"4Gi"}}},
  {"op":"add","path":"/spec/persistentContents","value":["filesystem"]}]'
```

没有迁移。旧镜像创建的 Sandbox 会恢复暂停策略；新镜像创建的、已领取的 Sandbox 保持删除策略直到被删除。

## 2. Finalcut（1 vCPU / 4 GiB）

- **对照**：复用 #312 的 Agent `agent_BE4F7mWvPvtAPIaVtjKPK`（deepseek-flash、thinking high、19 个 Skill、`env_video_production`；#312 的源 Agent 已删除）、同样 18 个 EP23 输入（从 #312 组 A 的 oma-test Workspace `ws_dQ96XGT-4f04oSRiGW5b-` 服务端复制到新 Workspace `ws_USaCp4bZbADI1v6Ykhu76`，etag 逐个相同）和同一条 Prompt。临时 API key `apikey_IKLQtkTLSBLryY9a6Uly9`（测试 Tenant `f00c7d5a…`，在 oma-test API Pod 里创建），结束后吊销（再用 401）。
- **Session** `sess_ADr9gdbACDgeSklHJSc32`：10:01:58.080Z 提交，10:11:03.116Z `turn_completed`，**545 s**；1 个 `turn_completed`、0 个 `session.error`；60 次工具调用，1 次非零退出（Agent 自己的探测命令，随后继续）。
- **领取**：`claimMs=727`，`swapped=false`，准备 1,096 ms；Skill Set 安装 999 ms（19 个，1.98 MB）。
- **产物**：`final.mp4` 480×854、2117 帧、88.208 s、h264 + aac，本机 ffmpeg 完整解码无错误；`result.json` `status: success`、`errors: []`、`geometry_pass: true`、字幕与分镜英文台词一致、无字幕重叠。
- **资源**（`kubectl top`，每 15 s 一次，33 个样本）：`sandbox` 容器 CPU 最高 960m（10:04:35–10:05:21 连续 4 个样本 ≥ 958m，即顶满 1 核），内存最高 539 Mi；`csi-agent-sidecar` 最高 82m / 101 Mi。重启 0 次，没有 OOMKilled。
- **耗时对照**（都是 2C4G）：oma-test #312 组 A 487 s（同 Agent、同输入）、组 B 583 s（原地换镜像）；生产 10-26 回归 536 s。545 s 在 2C4G 的波动范围内；模型请求次数和工具调用路径每次不同，单次运行不能精确量出 1 核的减速。工具耗时最长的两步：`precise-subtitles` 生成与烧录 92.3 s（组 A 的同一脚本各阶段合计约 73 s）、ffmpeg 拼接 63.4 s。

## 3. 生命周期

| 时间 | 事件 |
|---|---|
| 10:02:03Z | 领取 `oma-test-sandbox-pw8vx`：CR 只有 `spec.shutdownTime`（10-31 10:02:03Z，24 h），没有 `pauseTime` |
| 10:11:03Z | Turn 结束；`shutdownTime` 缩短为 10:26:03Z（15 min） |
| 10:26:04Z | Pod 四个容器 `Killing`；10:26:24Z Sandbox CR 和 Pod 都已 NotFound，没有 Paused 状态 |
| 10:27:10Z | 探测 Turn（16 min 后）：Turn 开始的准备 `outcome: deferred`（42 ms，连接已删除的 Sandbox 得到 NotFound，绑定回到 Cold） |
| 10:27:17Z | 第一次工具调用从 Warm Pool 领取 `oma-test-sandbox-rfgjf`：`claimMs=380`、`swapped=false`、准备 645 ms；Skill Set 重新安装 995 ms；`shutdownTime` 10:42:22Z，没有 `pauseTime` |
| 10:27:21Z | 命令输出：`nproc` = 1，内存 total 4096 MB，`/` 30G，`outputs/regression-finalcut/final.mp4` 仍在 Workspace |
| 10:29:14Z | 终止 Session：10:29:18Z Pod `Killing`，10:29:20Z CR 消失；绑定行 `sandbox_id`、`creating_since` 都为 null，`reclaiming` false |

- **配额**：cn-shanghai 按量 vCPU 用量 10:12Z 为 87，10:26:54Z 为 85。当时集群里所有 ACS Pod 合计 79.75 vCPU，生产还有 4 个 Paused（旧策略，各 2 vCPU），合计 87.75 ≥ 85，没有给被删 Sandbox 保留实例的余量。生产这段时间有活动（新的 Running、Paused 和一个到期删除），所以这不是受控测量。
- **Sweeper**：发布后 Runner 日志 5 轮 `sandbox_sweep`，每轮 `listed: 1`、`killed: 0`、`shortened: 0`、`failed: 0`（oma-test 的网关 key 只列出 oma-test 已领取的 Sandbox）。

## 4. 与预期不同的两点

1. **ACS 临时存储下限是 30 GiB。** 交接文档说 15 GiB 是下限；实际上领取的 Pod 带 `alibabacloud.com/pod-ephemeral-storage: 30Gi`，容器的 `ephemeral-storage` request 被改成 30Gi，`df -h /` 为 30G。两个池清单和 ADR-0025 都改为 30Gi（`ebe63674`），oma-test 池模板 10:28Z 同步。
2. **网关会写 `reserve-paused-sandbox-duration: forever`。** 新代码不再发这个元数据，但领取的 Sandbox CR 上仍有 `agents.kruise.io/reserve-paused-sandbox-duration: forever`。删除策略的 Sandbox 没有 `pauseTime`，所以不受影响；但这个注解不能用来找旧策略的 Sandbox。ADR-0025 改为用 `spec.pauseTime` 判断（`8a1f4a3b`）。

## 5. 没有覆盖的

- AutoShort 第 3–5 步：要调用 Seedance 等外部生成，这次没有跑。生产 15 天的数据里这几步 CPU p99 为 0.63–0.97 核、内存 p99 ≤ 0.77 GiB。
- oma-image-builder 的校验 Sandbox：和 Runner 用同一个 `E2BSandboxClient.create`，这次没有触发构建，没有单独观察它到期删除。
- 生产：没有改动。生产发布前要按 ADR-0025 的 Rollout 先查有 `spec.pauseTime` 的已领取 Sandbox。10:31Z 生产已领取的 Sandbox 都是旧策略（都有 `pauseTime`）：1 个 Running、4 个 Paused。
