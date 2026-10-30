# ADR-0025 生产发布记录

2026-10-30（时间均为 UTC）。在 [oma-test 验收](sandbox-1c4g-oma-test-2026-10-30.md)通过后，经维护者同意，把 PR #320 的镜像和 Warm Pool 模板发布到生产。按生产惯例只改镜像和池模板中的两个字段，不应用渲染出的整份清单；Runner 保持 3 个副本。

## 发布前

| 检查 | 11:02Z 结果 |
|---|---|
| 线上镜像（回滚目标） | oma-api、oma-runner（3）、oma-image-builder 都是 `oma-server@sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d`；oma-web `b0d6399e…` 不变 |
| `oma-sandbox` | 8 副本、2 CPU / 4Gi / 50Gi、`persistentContents: [filesystem]`、8/8 可用；完整对象另存，没有重新应用（镜像归 builder 管） |
| `oma` schema | 0 个运行中的 Session，0 条待处理输入，0 个未完成的 Environment 构建 |
| 旧策略 Sandbox（已领取且有 `spec.pauseTime`） | 4 个：`dkj6f`、`vltfh`、`xpptm` Paused，`hc258` Running（空闲，30 分钟期限 11:17Z）。四个绑定都没有排队输入、没有资源占用，Session 都是 idle |

## 发布

| 步骤 | 时间 | 结果 |
|---|---|---|
| 池模板 | 11:03:40Z | JSON patch（先 `--dry-run=server`，并用 `test` 断言容器名和旧 CPU）：`containers[0].resources` = requests/limits 1 CPU、4Gi，临时存储 30Gi；删除 `spec.persistentContents`。8 个池 Pod 在 11:03:40–11:05:42Z 重建，全部 `pod-use-spec=1-4Gi`、`pod-ephemeral-storage=30Gi`，8/8 可用 |
| oma-image-builder | 11:03:48Z → 11:04:59Z | `kubectl set image … builder=oma-server@sha256:6d5823b163d3a92d23b4981db92a93ad64dc8dd2e47731aab0ef4df6a8ad015a`（Recreate）；当时没有构建在跑 |
| oma-api | → 11:05:35Z | 同一镜像 |
| oma-runner | → 11:07:32Z | 同一镜像，3 个副本滚动；`/api/health` = ok |
| 旧策略 Sandbox | 11:07:55Z | 再次确认四个绑定仍空闲、生产 0 个运行中的 Session 后，在新 Runner Pod 里用 Runner 自己的 `E2BSandboxClient.destroy` 按 id 删除四个，全部确认 NotFound；脚本随后从 Pod 删除。它们的绑定在下一个 Turn 连接时得到 NotFound、回到 Cold |

## 发布后

- 11:08Z：没有任何已领取的 Sandbox，也没有任何 Sandbox 带 `spec.pauseTime`；池 8 个、oma-test 池 1 个都是 Running。
- 新 Pod 日志没有错误；新 Runner 的第一轮 `sandbox_sweep`：`killed: 0`、`failed: 0`。
- cn-shanghai 按量 vCPU 用量 11:08Z 为 74（10:26Z 为 85）。
- 发布时生产没有流量；第一个真实 Turn 领取的 Sandbox 应只有 `shutdownTime`、没有 `pauseTime`，空闲 15 分钟后被删除。

## 回滚

```bash
export KUBECONFIG=~/.kube/agent-platform-config
OLD=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d
kubectl -n oma-infra set image deploy/oma-image-builder builder=$OLD
kubectl -n oma-infra set image deploy/oma-api api=$OLD
kubectl -n oma-infra set image deploy/oma-runner runner=$OLD
kubectl -n sandbox-system patch sandboxset oma-sandbox --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/resources","value":{"limits":{"cpu":"2","memory":"4Gi"},"requests":{"cpu":"2","ephemeral-storage":"50Gi","memory":"4Gi"}}},
  {"op":"add","path":"/spec/persistentContents","value":["filesystem"]}]'
```

没有迁移。回滚后，新镜像期间领取的 Sandbox 保持删除策略直到被删除；旧镜像再领取的恢复暂停策略。
