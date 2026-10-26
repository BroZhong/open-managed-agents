# Environments 运行时：oma-test 发布与验收（#306 / #307 / #311）

2026-10-26（Asia/Shanghai）。集成分支 `docs/adr-0024-environments` 的 `5abd8031` 发布到 oma-test，并在一个临时测试 Tenant 里逐项验收。只动了 `oma-test` 命名空间和 `oma_test` schema。

**结论：全部验收项通过。**

1. **#306：** Session 在冻结的 Environment 里运行。绑定测试 Environment 的 Agent 不安装就能用 `figlet`；重建后新 Session 拿到新镜像，正在运行的 Sandbox 保持旧镜像。Session 的 `environmentId` 覆盖生效，没指定的 Agent 默认 video-production。Session API 返回 `environment: {id, name}`，span 和绑定行都带 environmentId/image，领取时带 swapped/claimMs。
2. **#307：** Environment 变量和 Tenant 密钥按命令注入。改 `PROBE` 后，同一 Sandbox 的下一条命令就看到新值，不需要重建。canary 不出现在 Sandbox CR（含 `init-runtime-request`）、Pod、Session 事件和服务日志里。
3. **#305 运行时：** 代理变量到达命令。GitHub 经 sing-box；阿里云 pip 镜像和 OSS 内网端点直连；MediaKit 真实云端调用通过鉴权；vfs-cli 读到 test 策略。
4. **#311：** 0029 绑定了全部 38 个有 Sandbox 的 Agent（10 个 Tenant 副本），清掉了 10 个 Agent 和 1848 个快照里的 `sandbox.image/env`。迁移前的 Session 继续工作；命令只从 Environment 取变量；API 拒绝 `sandbox.image/env`。
5. **要注意的两点：**
   - 0029 的副本立刻各自完整构建一次：10 个 4 vCPU 的构建 Pod 同时运行，每个 26–37 分钟，产出 10 个不同的 digest，而定义与 video-production 完全相同。生产发布前要先用计数脚本确认副本数，并为这些构建预留 ACS 配额（与 oma-test 共用）。
   - 有两个副本把原 `sandbox.env` 里的明文 VFS 凭据带成了明文变量。

## 发布

| 项 | 值 |
|---|---|
| 源码 | `5abd8031`，vfs-dev `~/workspace/yuzhong/oma-env-5abd8031`（git bundle），`bash build.sh --push server web` |
| oma-api / oma-runner | `oma-server@sha256:298ec946812be754666b2c264f49a90d713c255225fdb1dbd1d5db617b5db3f0`（tag `5abd80311646`） |
| oma-web | `oma-web@sha256:46c363546a121bb75b612ba2a0a33249a03964d9f929838215df29c0b3119f8d` |
| oma-image-builder | 不变：`oma-server@sha256:61e257409a100d8fcf1b479fc0bb5ef2cbf9fcaad7bec3f4b0c1ded614270a02` |
| 回滚镜像 | api `oma-server@sha256:61e25740…`、runner `oma-server@sha256:fc7eebd0…`、web `oma-web@sha256:d99b9db6…`（017d2b18），再跑 0029 回滚 SQL |

**`kubectl diff` 只有预期的变化：**

- 三个 Deployment 换镜像，builder 不变。
- Runner 去掉 `DEFAULT_SANDBOX_VFS_TOKEN` 变量和 `envFrom: oma-auto-story-env`（optional）。
- `oma-runner-config` 去掉 `SANDBOX_IMAGE`。其余已删的键（`DEFAULT_SANDBOX_*`、`AUTO_STORY_*`）在线上 ConfigMap 里本来就没有。
- 没有删 Secret。`oma-test/oma-auto-story-env` 现在没有引用，留给维护者删除。

apply 后 redis、oma-api、oma-runner（2 副本）、oma-web、oma-image-builder 全部 rollout 完成，`/api/health` 返回 `{"status":"ok"}`。

## 迁移 0029

`migration-for-env.mjs test` 改写后，经 Supabase MCP `execute_sql` 执行（RPC 本身是一个事务，所以去掉了 `BEGIN;` / `COMMIT;`）。前置条件满足：`env_video_production` 有镜像。计数用 `deploy/scripts/environment-migration-counts.sql`，只打印名字和数量。

| 计数 | 迁移前 | 迁移后 |
|---|---|---|
| video-production 可用 | 1 | 1 |
| 有 Sandbox 的 Agent | 38 | 38 |
| 其中没有 Environment | 38 | 0 |
| 其中带 `sandbox.env` | 10 | 0 |
| 带 `sandbox.image` / `sandbox.env` 的 Agent | 10 | 0 |
| 没有 Environment 的 Session | 1963 | 14 |
| 快照带 `sandbox.image` / `sandbox.env` 的 Session | 1848 | 0 |
| 0029 建的 Tenant 副本 | 0 | 10 |
| Agent / Session 总数 | 50 / 1963 | 50 / 1963 |
| 备份表 `migration_0029_agents` / `_sessions` | — | 38 / 1949 |

- **绑定结果：** 28 个 Agent 绑 `env_video_production`，10 个带 `sandbox.env` 的 Agent 各得一个副本 `env_<agentId>`。
- **剩下没有 Environment 的都是不用 Sandbox 的：** 12 个 Agent 都是 `sandbox.enabled=false`；14 个 Session 属于这些 Agent。
- **Session 冻结到 Agent 的结果：** video-production 101 个；副本 1 至 556 个不等，共 1848 个。
- **丢弃的变量全部是空值，没有一个是因为系统保留。** 10 个 Agent 各有 33 至 40 个名字，丢掉 25 至 28 个空值，保留 7 至 14 个。副本在 video-production 的 25 个变量上覆盖同名项、追加其余，得到 29 至 35 个。
- **两个副本带着明文凭据。** `agent_M794Gt4iPwX-ZblaA_lW2` 和 `agent_tdpcn95CKCCQzEAa5SBGz` 的 `sandbox.env` 里有非空的 `VFS_ACCESS_TOKEN` / `VFS_TOKEN`，按 ADR 以明文变量带进了副本。它们原来就以明文存在 Agent 上，暴露面没变，但应改成 Tenant 密钥（留给维护者）。
- **副本的构建立刻开始了。** 运行中的 builder 同时领走 10 个 pending build，起了 10 个 4 vCPU / 8 GiB 的构建 Pod（共 40 vCPU）。它们的定义与 video-production 相同，构建期间副本照常提供 video-production 的镜像。

## 验收准备

- **临时凭据：** 一次性 Tenant `env-accept-1792978750`，API key `apikey_envaccept1792978750` 直接写入 `oma_test.api_keys`（本地生成、只存 sha256；用完吊销）。
- **Agent：** `openai-codex/gpt-5.6-sol`，开启 Sandbox，system 要求只执行给定脚本并原样回报输出。
- **测试 Environment：** `accept-figlet-1792978750`（`env_uMYjLgDWttUpmSsW-keFZ`）。复制 video-production，在脚本末尾加装 `figlet`（video-production 的清单里没有），变量加 `PROBE=first` 和 Tenant 密钥 `ACCEPT_CANARY`（随机值，只存在本机文件里）。创建的应答里没有 canary。

## #305 运行时：video-production Session

Agent `agent_FDUTDBn4ogOGHyDEQIxwH` 创建时没有指定 Environment，Session `sess_EWvwfxsBZZkddYLkJLsbk`。

| 检查 | 结果 |
|---|---|
| 命令里的代理变量 | `HTTP(S)_PROXY` 与小写形式都是 `http://sing-box.oma-infra.svc.cluster.local:7890`；`NO_PROXY` / `no_proxy` = `localhost,127.0.0.1,::1,.svc,.cluster.local,.aliyuncs.com,.aliyun.com,.npmmirror.com` |
| `curl -sI https://github.com` | 200，对端 `10.0.165.246:7890`，即 sing-box 的 ClusterIP（Sandbox 内 `getent hosts` 解析） |
| 阿里云 pip 镜像 | `https://mirrors.aliyun.com/pypi/simple/pip/` 200，对端 `180.121.81.85:443`，直连；`pip download six` 从该镜像成功 |
| OSS 内网端点 | `https://oss-cn-shanghai-internal.aliyuncs.com/` 403（匿名访问的正常应答），对端 `100.118.102.35:443`，直连 |
| MediaKit | `mediakit-cli doctor`：`cloud_ready: true`。真实云端调用 `shared query-task` 查一个不存在的任务，返回 `NotFound`；同一命令去掉 `MEDIAKIT_API_KEY` 后返回 `MissingAuthentication`。说明平台密钥按命令到达，并被云端接受 |
| vfs-cli 策略 | `/etc/vfs-cli/policy.json` = `{"environment":"test"}`；`RUNTIME_ENV=PRO vfs-cli project query` 被拦下，`environment_policy_conflict` |
| 测试变量不外泄 | 这个 Session 的命令里 `PROBE`、`ACCEPT_CANARY` 都是 unset；`figlet` 不存在 |
| span | `sandbox_prepare_start` {environmentId `env_video_production`, image `oma-environments@sha256:54d89827…`}；`_end` {outcome ready, 同一 image, swapped false, claimMs 589, durationMs 942} |
| Session API | `environment: {id: env_video_production, name: video-production}` |

## #311：迁移前的 Session 继续工作

Session `sess_GvEL-gpjLW_zI1qNkj0mV`（Tenant `smoke283-1792833235618`，10-24 创建，迁移后冻结到 `env_video_production`），用该 Tenant 的第二个临时 API key 发一条消息。

- Session API：`environment: {id: env_video_production, name: video-production}`，`sandbox.state: ready`，没有 `last_error`。
- 新领取一个 Sandbox：`sandbox_prepare_end` {outcome ready, image `oma-environments@sha256:54d89827…`, swapped false, claimMs 550}。绑定行记下了 `environment_id = env_video_production` 和同一 image。
- 命令以 `user` 在 `/home/user/workspace` 运行，ffmpeg 9.0.1、vfs-cli v0.3.21 可用，`/opt/oma/manifest.json` 存在；`HTTP_PROXY`、`NO_PROXY`、`MEDIAKIT_API_KEY`、`VFS_TOKEN` 为 set，`PROBE` / `ACCEPT_CANARY` 为 unset。
- 检查完把这个 Session 终止了，Sandbox 随之释放。

## #306 / #307：绑定测试 Environment 的 Session

`accept-figlet-…` 构建约 30 分钟（01:41–02:10 UTC，与 0029 的 10 个副本构建同时进行；video-production 单独构建约 6 分钟），产出 `oma-environments@sha256:2016c260…`。构建完成前，绑定它的 Agent 被拒：409 `environment_not_ready`。之后 Agent `agent_s2YUS6n7I0LZDTchZdX8U` 绑定它，Session `sess_kAN5er_AON-5dwoK-sbDy`，API 返回 `environment: {id: env_uMYjLgDWttUpmSsW-keFZ, name: accept-figlet-1792978750}`。

| 检查 | 结果 |
|---|---|
| 领取 | `sandbox_prepare_start` {environmentId `env_uMYjLgDWttUpmSsW-keFZ`, image `…@sha256:2016c260…`}；`_end` {outcome ready, 同一 image, swapped **true**, claimMs 24482, durationMs 24938, sandboxId `…oma-test-sandbox-2fs5b`}。池里是 video-production 镜像，所以就地换镜像 |
| 工具 | `figlet` 在 `/usr/bin/figlet`，dpkg `install ok installed` 2.2.5-3+b1，`figlet OK` 正常输出。这个 Turn 只有一次 tool_use（即给定脚本），没有安装 |
| 变量 | `PROBE=first`；`ACCEPT_CANARY` 长度 31，sha256 前 16 位 `be685ab5…` 与本机计算一致（命令只打印哈希） |
| 改变量 | 通过 API 把 `PROBE` 改成 `second`（`ACCEPT_CANARY` 只给 secretRef，保留原值）。只改变量不触发构建：`lastBuild` 与 image 不变，状态 ready |
| 同一 Sandbox 的下一条命令 | 仍是 `oma-test-sandbox-2fs5b`（复用，`_end` 不带 swapped/claimMs，durationMs 391），打印 `PROBE=second`，canary 哈希不变 |
| 命令看到的变量名 | Environment 的 27 个（video-production 的 25 个 + `PROBE` + `ACCEPT_CANARY`）+ 平台默认 `PIP_INDEX_URL`、`NPM_CONFIG_REGISTRY` + 11 个 `WORKSPACE_ENV` + shell 自带的（`PATH`、`PWD`、`OLDPWD`、`SHLVL`、`USER`、`LOGNAME`、`E2B_SANDBOX`）。没有别的来源：不再引用的 `oma-auto-story-env` 的三个键（`AUTO_STORY_AGENT_IDS`、`AUTO_STORY_SANDBOX_ENV_JSON`、`KIMI_CODING_API_KEY`，只读了键名）都不在其中 |
| canary 不外泄 | 只用 `grep -c` 统计 canary 出现次数，全部为 0：Sandbox CR `sandbox-system/oma-test-sandbox-2fs5b`（含 `agents.kruise.io/init-runtime-request`）、对应 Pod、三个 Session 的全部事件、oma-api 与两个 oma-runner 近 2 小时的日志、创建 Environment 的应答。annotation 的 `envVars` 只有 11 个 `WORKSPACE_ENV` 名字，没有任何 Environment 变量（`PROBE` 也没有），即创建时不注入 Environment 变量 |

## #311 / #306：API 规则

| 请求 | 结果 |
|---|---|
| 创建 Agent 带 `sandbox.image` | 400 `sandbox_image_removed` |
| 创建 Agent 带 `sandbox.env`；更新 Agent 带 `sandbox.env` | 400 `sandbox_env_removed`（两次） |
| 创建 Agent 不指定 Environment | 201，`environmentId: env_video_production` |
| 绑定从未构建成功的 Environment | 409 `environment_not_ready` |
| 把 Sandboxed Agent 的 `environmentId` 设为 null | 400 `environment_required` |
| 创建 Session 时 `environmentId` 指向不存在的 Environment | 404 `environment_not_found` |
| 数据库：有 Sandbox 的 Agent | 38 个全部有 Environment；没有的 12 个都是 `sandbox.enabled=false`，按 ADR 本来就没有 |

## #306：重建后新旧 Sandbox

在初始化脚本末尾加一行 `echo accept-v2 > /etc/oma-accept-version`。改脚本自动开始重建，构建期间状态 pending/building，仍提供旧镜像。重建 02:35–02:49 UTC（约 14 分钟，单独构建），产出 `oma-environments@sha256:f0213c91…`。

| Sandbox | 结果 |
|---|---|
| 原 Session 正在用的 `oma-test-sandbox-2fs5b` | 下一条命令仍是旧镜像：没有 marker，`PROBE=second`。span：`_start` 的 image 是新镜像 `f0213c91…`（如果领取会用它），`_end` 是复用，image 为绑定记录的旧镜像 `2016c260…`。绑定行与 Sandbox CR 也都是 `2016c260…` |
| 新 Session `sess_xrCGt9qZrAq92qHymvJyw` | Agent `agent_FDUTDBn4ogOGHyDEQIxwH` 本身绑定 video-production，Session 创建时用 `environmentId` 覆盖为测试 Environment，API 返回该 Environment。领取 `oma-test-sandbox-nh8xk`：swapped true，claimMs 24687，image `f0213c91…`；命令打印 `accept-v2`、`PROBE=second`、同一 canary 哈希，figlet 可用。Sandbox CR 也是 `f0213c91…` |

两次换镜像领取的 claimMs 都在 24.5 s 左右（池 Pod 要拉取 Environment 新增的层）；不换镜像的领取约 0.55–0.59 s。

## 清理与边界

- 四个测试 Session 都已终止，对应的 4 个 Sandbox（`cwcdq`、`lcmbs`、`2fs5b`、`nh8xk`）都已删除；同时存在的测试 Sandbox 最多 2 个。
- 两个临时 API key 已通过 API 吊销（再用返回 401），本机的 key 文件和 canary 文件已删除。
- 留在 `oma_test`：Tenant `env-accept-1792978750` 的两个 Agent 和测试 Environment（镜像在 `oma-environments` 仓库里），以及迁移备份表 `migration_0029_agents` / `_sessions`（验收通过后删除）。
- 留给维护者：Secret `oma-test/oma-auto-story-env` 已无引用，可以删除；上文两个带明文 VFS 凭据的副本。
- 只读访问了 `sandbox-system` 下本次测试 Sandbox 的 CR 和 Pod（只统计 canary 出现次数）。没有改动 oma-infra、auto-story-v2、base-secret 或生产 schema。

## 回滚

发布前线上的 Runner 配置不来自任何一个提交（`SANDBOX_IMAGE` 是 `oma-sandbox@sha256:2dd85aa3…`，与 017d2b18 之前的 overlay 都不同），所以回滚清单 = 当前 overlay 用旧镜像渲染，再补回 diff 删掉的三项。按这个做法生成的清单（本机 `~/oma-311/oma-test-rollback.yaml`）对线上做过 `kubectl diff`，正好是本次发布的逆操作。

```bash
export KUBECONFIG=~/.kube/agent-platform-config
node deploy/scripts/render.mjs test \
  sha256:61e257409a100d8fcf1b479fc0bb5ef2cbf9fcaad7bec3f4b0c1ded614270a02 \
  sha256:fc7eebd05e6b076c9664cf337b638cc24bdf1946c43509af3c8ee7bad01360bb \
  sha256:d99b9db6e284cd6a97a3d6fa567aaa957298a778a6def256a01718213a059b87 \
  sha256:61e257409a100d8fcf1b479fc0bb5ef2cbf9fcaad7bec3f4b0c1ded614270a02 > /tmp/oma-test-rollback.yaml
# 在 /tmp/oma-test-rollback.yaml 里补回：
#   oma-runner-config：SANDBOX_IMAGE: registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:2dd85aa3e0317bd06735e2ebc6ed6ef5db075b7b0c2b3c7f83060704a960f2e4
#   oma-runner 容器：RDS_MCP_APIKEY 之前加 DEFAULT_SANDBOX_VFS_TOKEN（secretKeyRef oma-secrets/DEFAULT_SANDBOX_VFS_TOKEN），
#                    envFrom 的 configMapRef 之后加 secretRef oma-auto-story-env（optional: true）
kubectl diff -f /tmp/oma-test-rollback.yaml; kubectl apply -f /tmp/oma-test-rollback.yaml
# 旧镜像跑起来之后执行 0029 回滚（经 MCP 时去掉 BEGIN/COMMIT）：
node deploy/scripts/migration-for-env.mjs test deploy/migrations/0029_environment_migration.rollback.sql
```
