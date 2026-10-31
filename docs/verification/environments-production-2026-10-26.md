# Environments 生产发布与回归（ADR-0024，#298）

2026-10-26。带 Z 的时间为 UTC。main `0b97e879`（PR #316）的镜像加上 PR #317（main `238fac48`，生产 Warm Pool `oma-sandbox` 与发布配置）发布到生产 `oma-infra` / schema `oma`，并做冒烟和一次 Finalcut 回归。

**结论：发布完成，全部回归项通过。**

1. 生产现在从新 Warm Pool `sandbox-system/oma-sandbox` 领取 Sandbox，8 副本，镜像是生产自己构建的 video-production（`oma-environments@sha256:189b55700aa7…`），Pod 全部命中 ImageCache。
2. 0029 把 57 个开沙箱的 Agent 都绑定到了 Environment：56 个绑 `env_video_production`，1 个绑 Tenant 副本。迁移还清掉了 841 个 Session 快照里的 `sandbox.image/env`。迁移前已在运行的 Session 换到新 Runner 后继续执行，没有报错。
3. 冒烟：工具、代理、平台密钥、MediaKit、span、Session API 都符合预期。
4. Finalcut 回归 536 s 完成。`final.mp4` 是 480×854、2117 帧、88.208 s，与 10-25 的对照 Session 帧数和时长相同；本机完整解码无错误。全程没有 vfs-cli 调用、没有上传或发布、没有安装。
5. 发现两件事：发布期间有另一个客户端在跑生产回归（§6）；生产 builder 的 apt 下载只有约 110 kB/s，video-production 构建用了 12.5 min（§2）。都不是这次发布引入的问题。

## 1. 发布步骤

| 步骤 | 时间 | 结果 |
|---|---|---|
| 构建镜像 | 08:33Z | vfs-dev `~/workspace/yuzhong/oma-env-0b97e879`（git bundle，`.buildx-cache` 从 `oma-env-7d360db8` 复制），`bash build.sh --push server web`。tag `202610261633`：`oma-server@sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d`，`oma-web@sha256:4a78b4cc8339f9dbcd88e1544c71c2a90a3586417fe0ac4de4392c947570cee4`。#317 只改清单和文档，镜像内容不受影响 |
| 测试服彩排 | 08:39:03–08:40:50Z | oma-test 的 4 个 Deployment 换成上面的镜像。`kubectl diff` 只有 4 行镜像变化，builder 启动后没有排任何构建。冒烟 Session `sess_S8Nnlm5FLOzgJSbJ6s_No` 通过（项目同 §4） |
| PR #317 | 08:44:24Z 合入 | 新增 `sandbox/warm-pool/oma-sandbox.yaml`；生产 Runner 和 builder 改为 `SANDBOX_TEMPLATE=oma-sandbox`；builder 改为 `WARM_POOL_ENVIRONMENT=env_video_production`。测试服渲染结果与改动前逐字节相同 |
| 迁移 0026、0028、0030 | 08:44Z | 通过 Supabase MCP `execute_sql` 执行，去掉 `BEGIN;`/`COMMIT;`，保留 `lock_timeout`。核对结果：新表和新列都已存在；`oma_app` 对两张新表有 SELECT/INSERT/UPDATE、没有 DELETE；序列有 USAGE |
| Warm Pool `oma-sandbox` 与 builder 的 RBAC | 08:45:41Z | `kubectl apply` 了 `sandbox/warm-pool/oma-sandbox.yaml` 和 `deploy/image-builder-warm-pool-rbac.yaml`。8 个 Pod 在 22 s 内就绪，全部带 `matched-image-caches: imc-uf6do32uk5dsbid1cj13` 和 `ImageCacheHit` 事件 |
| oma-image-builder | 08:47:12Z apply，08:47:50Z Ready | 只 apply 生产渲染结果里 builder 的 5 个对象（ConfigMap、ServiceAccount、Role、RoleBinding、Deployment）。08:47:47Z 日志 `builtin_environment id=env_video_production change=created`，随即开始构建 |
| video-production 就绪 | 09:00:32Z | 见 §2 |
| 缓存与换池 | 09:00:33Z → 09:04:04Z | builder 新建 ImageCache `imc-uf6do32uk5dsd1lwi3qk`，等它 Ready 后打出 `warm_pool_updated`（4905… → 189b…）。到 09:06:12Z 池子 8/8 换成新镜像，8 个 Pod 都命中新缓存，每个约 21 s 就绪 |
| 迁移 0029 | 09:07:33Z | 见 §3 |
| API、Runner、Web | 09:08:27Z 开始 patch，09:10:55Z 全部 rollout 完成 | 见下 |

**API、Runner、Web 的改动**：生产历来只 patch 镜像和 ConfigMap 键，渲染出的完整清单会把 Runner 副本数重置成 2，还会带进 `WORKSPACE_OSS_INTERNAL_ENDPOINT` 的漂移。所以这次只做了这些：

- `oma-runner-config` 的 `SANDBOX_TEMPLATE` 从 `auto-story-v2` 改成 `oma-sandbox`。
- oma-runner：换镜像；去掉 env `DEFAULT_SANDBOX_VFS_TOKEN` 和 `envFrom: secretRef oma-auto-story-env (optional)`。用带 `test` 的 JSON patch，确认数组下标对应的条目正确后才删除。这两项与 oma-test 发布时去掉的一致，渲染清单里本来就没有。
- oma-api、oma-web：只换镜像。
- Runner 保持 3 副本滚动更新。完成后 `/api/health` = `{"status":"ok"}`；新 Pod 日志里没有 error，只有 undici 的 `EnvHttpProxyAgent is experimental` 警告。

**回滚**（旧值存在本机 `~/github/oma-wt/prod-rollback-20261026-environments.txt`，三个 Deployment 和 ConfigMap 的完整 JSON 也一并导出了）：

```bash
export KUBECONFIG=~/.kube/agent-platform-config
kubectl -n oma-infra patch cm oma-runner-config --type merge -p '{"data":{"SANDBOX_TEMPLATE":"auto-story-v2"}}'
kubectl -n oma-infra set image deploy/oma-api api=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:d668ced005b848dc363d0bcf7ae1c875d3f7ca3f3ddb560138d41951d7a59a32
# Runner（容器 runner）：换回 d668ced0…，并补回 envFrom secretRef oma-auto-story-env (optional) 和 env DEFAULT_SANDBOX_VFS_TOKEN（secretKeyRef oma-secrets）
kubectl -n oma-infra set image deploy/oma-web web=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:b479ad63dd99faa1bd1f5fa01d009107be4b836cd241a14b573eba1ab170409c
# 旧镜像跑起来之后再执行：0029_environment_migration.rollback.sql（经 MCP 时去掉 BEGIN/COMMIT）
kubectl -n oma-infra scale deploy/oma-image-builder --replicas=0
```

`auto-story-v2`（8 副本，`oma-sandbox@sha256:67a46af6…`）原样保留，没有改动。0026、0028、0030 只加不改，可以不回滚。

## 2. 生产 video-production 构建

build `envb_aSyMT9dOpZCpTlrAOb_yg`，日志在 `oss://agentry/__oma/environment-builds/platform/envb_aSyMT9dOpZCpTlrAOb_yg.log`。

| 阶段 | 时间 | 用时 |
|---|---|---|
| builder 写入 built-in → 领取 | 08:47:47Z → 08:47:48Z | 1 s |
| 构建 Pod 开始拉 `oma-media-0.1.2` | → 08:48:19Z | 31 s |
| 拉 Base Image | → 08:49:06Z | 47 s |
| init 脚本、清单、`/home/user` 归属 | → 09:00:12Z | 666 s（日志 `Built in 666 s`） |
| 推送 | → 09:00:24Z | 9 s |
| 校验：从 `oma-sandbox` 领一个 Sandbox | → 09:00:32Z | 8 s |
| **总计** | | **12 min 45 s** |

- 慢在 apt：`libgl1` 等包从 Debian 镜像下载，`Fetched 9395 kB in 1min 18s (120 kB/s)`，`Fetched 49.6 MB in 7min 28s (111 kB/s)`。oma-test 上单独构建同一脚本时，脚本部分是 194 s。镜像源的速度不是我们能控制的，不影响结果。
- 产出 `oma-environments@sha256:189b55700aa777a56f3812cac9c79f8623054c6b8c20d1c1c281157bf4c9cd6e`（tag `production-env_video_production-envb_aSyMT9dOpZCpTlrAOb_yg`）。`attempts=1`，`retries=0`，记录的 `base_image_digest` 为 `sha256:9a57f901…`，与 lock 文件一致。
- 0029 建的副本 `env_agent_KZY_BG2ffqP6WmLzcQxh3` 的构建 `envb_agent_KZY_BG2ffqP6WmLzcQxh3` 在 09:08:08–09:22:37Z 成功，产出 `…@sha256:…4bc63182300e9bdd`。构建期间这个副本继续使用 video-production 的镜像。

## 3. 迁移 0029

计数用 `deploy/scripts/environment-migration-counts.sql`，经 MCP 执行，只输出名字和数量。

| 计数 | 迁移前（09:07Z） | 迁移后 |
|---|---|---|
| video-production 可用 | 1 | 1 |
| 有 Sandbox 的 Agent | 57 | 57 |
| 其中没有 Environment | 57 | 0 |
| 其中带 `sandbox.env` | 1 | 0 |
| 带 `sandbox.image` / `sandbox.env` 的 Agent | 1 | 0 |
| 没有 Environment 的 Session | 9940 | 31（全部属于不用 Sandbox 的 Agent 或快照） |
| 快照带 `sandbox.image` / `sandbox.env` 的 Session | 841 | 0 |
| 0029 建的 Tenant 副本 | 0 | 1 |
| Agent / Session 总数 | 62 / 9940 | 62 / 9944 |
| 备份表 `migration_0029_agents` / `_sessions` | — | 57 / 9913 |

- **绑定结果**：56 个 Agent 绑 `env_video_production`；`agent_KZY_BG2ffqP6WmLzcQxh3`（Sing-box 分流验证）得到副本 `env_agent_KZY_BG2ffqP6WmLzcQxh3`。它的 7 个变量都是代理变量（`HTTP(S)_PROXY`、`NO_PROXY`、`NODE_USE_ENV_PROXY` 及小写形式），全部保留，没有丢弃任何名字，副本共 26 个变量。5 个 Agent 是 `sandbox.enabled=false`，按 ADR 不需要 Environment。
- **0029 与新 API 之间的空档**：从 0029（09:07:33Z）到新 API 就绪（09:09:24Z）之间，旧 API 新建了 3 个 Session：`sess_xdCYNTDxvd88EU7auwnjx`、`sess_DXs-g1zy0O-FdC48ifM18`、`sess_a6mDZGlqEw4HYj5MvGzXf`，它们的 Agent 都已绑定，但 Session 本身没有 Environment。新 Runner 接手时把它们解析到 `env_video_production`（span 带 `environmentId` 和 `189b…`），继续复用原来的 `auto-story-v2` Sandbox，没有报错。随后把 0029 原样再执行了一次（它是幂等的），这 3 个 Session 被冻结到 Agent 的 Environment，其余数据不变。之后不用 Sandbox 的 Agent 之外，没有 Session 缺少 Environment。
- **迁移前就在运行的 Session 继续可用**：上面这 3 个 Session 在 Runner 滚动时各被接管 1–3 次（`turn_resumed reason=released`），之后完成 Turn 或继续运行；`sess_xdCYNTDxvd88EU7auwnjx` 在新 Runner 上完成了 Turn，又开始了下一个。

## 4. 冒烟

临时 Tenant `env-release-smoke-20261026`，API key `apikey_relsmoke20261026p`：在本机生成，数据库里只存 sha256，用完吊销，再访问返回 401。Agent `agent_K0lqORkdq-ZSL65lUXJfr`（`openai-codex/gpt-5.6-sol`）创建时没有指定 Environment，自动得到 `environmentId: env_video_production`。Session `sess_K5NUDypVPNlrjPPSZbR3_` 执行一段给定脚本。

| 检查 | 结果 |
|---|---|
| 领取 | `sandbox_prepare_start`：`environmentId=env_video_production`，image `…189b5570…`。`_end`：`outcome=ready`，`swapped=false`，**`claimMs=431`**，`durationMs=685`，`sandboxId=…oma-sandbox-sbf2w` |
| 身份与清单 | 以 `user` 在 `/home/user/workspace` 运行；`/opt/oma/manifest.json` 生成于 09:00:04Z（即生产这次构建） |
| 工具 | ffmpeg 9.0.1、vfs-cli v0.3.21、mediakit-cli 0.2.1、ossutil 2.2.0；cv2 4.11.0、scenedetect 0.7.1、PIL 11.3.0、fontTools 4.61.1；`import whisper` 报 ModuleNotFoundError（Whisper 已按计划去掉） |
| 代理 | `HTTP(S)_PROXY` = sing-box；`curl -I https://github.com` 返回 200，对端 `10.0.165.246:7890`（sing-box）；OSS 内网端点 403（匿名访问的正常应答），对端 `100.118.102.35`，直连 |
| 平台密钥（只看是否存在） | `MEDIAKIT_API_KEY`、`VFS_TOKEN`、`GOOGLE_API_KEY`、`OSS_READ_ACCESS_KEY_ID` 都是 set |
| MediaKit | `doctor`：`cloud_ready: true`；用真实云端调用 `shared query-task` 查一个不存在的任务，返回 `NotFound`（说明鉴权通过） |
| vfs-cli 策略 | `/etc/vfs-cli/policy.json` = `{"environment":"test"}`，与原来 `auto-story-v2` 挂载的 `vfs-cli-policy-test-v1` 内容相同 |
| Workspace | 写、读、删一个文件都正常 |
| Session API | `GET /v1/sessions/{id}` 返回 `environment: {id: env_video_production, name: video-production}` 和 `sandbox: {state: ready, last_error: null}` |
| Environment API | `GET /v1/environments` 返回 `env_video_production`（ready，platform，image `…189b…`） |

控制台 Resources → Environment 页面没有在浏览器里看：本机浏览器连接超时。页面的数据来自上面的 API。

## 5. Finalcut 回归（生产）

方法同 [finalcut-oma-test-2026-10-26.md](finalcut-oma-test-2026-10-26.md) 的组 A，但在生产执行。

- **身份**：业务 Tenant `c8d17631-…` 的临时 key `apikey_relfinalcut20261026`，本机生成，数据库里只存 sha256，09:29:17Z 吊销，再访问返回 401。
- **Agent**：`agent_tLw7W4UpYpZOnmJ3fzlzu`（`finalcut-prod-environments-20261026`），由 10-25 的生产对照 Agent `agent_XsS1yQXmJS212Ag7SsmTk` fork 而来。模型 deepseek-flash、thinking high、19 个 Skill 都与对照相同，`environmentId: env_video_production`。system 末尾追加了与 oma-test 相同的约束：禁止任何 VFS 写入、上传或发布，输出只写 `outputs/regression-finalcut/`。原 system 298 字符，追加后 696 字符。
- **输入**：新 Workspace `ws_Iwbb3SpkeCtUFbUzsma47`，从同一 Tenant 的 `tw_b4293796…` 用 OSS 服务端复制 18 个 EP23 输入，共 42,582,669 B；复制后逐个核对大小、etag 和路径，全部相同。没有复制任何旧输出。
- **Prompt**：与 oma-test 回归相同。

| 项 | 结果 |
|---|---|
| Session | `sess_lUn4P86EEYzovYVGSG9cO`，API 返回 `environment: video-production` |
| 发消息 → `turn_completed` | 09:18:12Z → 09:27:08Z，**536 s** |
| `turn_completed` / `session.error` / `turn_resumed` | 1 / 0 / 0 |
| 领取 | `swapped=false`，`claimMs=457`，`sandboxId=…oma-sandbox-j4kh2`；Skill 安装 19 个、1,996,552 B，939 ms |
| 工具调用 / 结果 | 59 / 59（bash 44、read 12、write 3）；1 个 `isError`，是 Agent 自己写的临时脚本出错，下一步改正了 |
| vfs-cli、OSS CLI、pip/apt/npm 安装、curl/wget、子 Agent | 都是 0 |
| MediaKit | `video asr-subtitles` 加 `shared query-task`，成功 |
| `final.mp4`（下载到本机核对） | 480×854，24 fps，**2117 帧，88.208 s**，H.264 High + AAC，16,408,596 B，sha256 `a63a8aef…`。`ffmpeg -v error -i final.mp4 -f null -` 退出码 0，stderr 为空 |
| 字幕 | `build/report.json`：`geometry_pass: true`，27 条，Skill 默认样式（font 34 / baseline 35 / bottom 122 / side 26 / max_width 428 / stroke 2 / 2 行），ASS 字号 37.984375，后端 ffmpeg-libass。`result.json`：剧本 10/10 行覆盖，逐字一致 |

- **与对照比较**：对照 `sess_aXqzfulooKU5gjvszDfX1` 为 2117 帧、88.208 s、28 条字幕、545 s，这次的帧数和时长与它完全相同，耗时差 9 s。字幕 27 条对 28 条，差在 Agent 如何切分长句。oma-test 组 A 是 487 s。
- **监控**：运行期间多次只读查询这个 Session 的全部 `toolCall`，用正则查 vfs-cli、写或发布类命令、安装和网络调用。中途有 3 次命中，逐条看过都是误报：两次是 Agent 在报告里写"没有执行 upload/publish"，一次是脚本里的 "curly quotes" 命中了 `curl`。
- **保留的东西**：Agent `agent_tLw7W4UpYpZOnmJ3fzlzu` 和 Workspace `ws_Iwbb3SpkeCtUFbUzsma47`（输出共 463 个对象、约 84 MB）留在该 Tenant 作为证据，做法同 10-25 的回归。Session 已终止，Sandbox 已释放。

## 6. 发布期间观察到的情况

- **另一个客户端在跑生产回归**：从 09:14Z 起，Tenant `env-prod-regression-1793006070059` 先后建了 Environment `env_iBOnyCYqZW7011hksjVRf`（基于 oma-base，构建 3 次：成功、成功、一次故意的失败，脚本 42 字符、exit 23，`environment_build_script_failed`），然后按 1、4、8 个一组地创建 Session，并做 resume 测试。每一步都用新的临时 key，用完即吊销，Session 都已终止。这不是本次发布执行的，对本次发布没有影响。
- **生产 builder 的 apt 下载慢**：见 §2。
- **pg 的 `DeprecationWarning`**（同一个 client 上并发 query）：builder 启动时打出一条，oma-test 以前就有。

## 7. 还没做的事（需要确认后再做）

- 删除 SandboxSet `auto-story-v2`（8 副本，占 16 vCPU）。这之后就不能再回滚到旧池。
- 删除 `oma.migration_0029_agents` 和 `oma.migration_0029_sessions`。删除后 0029 的回滚 SQL 不再可用。
- 删除 Secret `oma-infra/oma-auto-story-env`（键名：`AUTO_STORY_AGENT_IDS`、`AUTO_STORY_SANDBOX_ENV_JSON`、`KIMI_CODING_API_KEY`）。现在已经没有引用；删除前要先确认 `KIMI_CODING_API_KEY` 是否还要保留在别处。`oma-secrets` 里的 `DEFAULT_SANDBOX_VFS_TOKEN` 也不再被引用。
- 关闭 #298。
