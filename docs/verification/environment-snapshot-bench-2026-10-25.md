# Environment 启动路径基准：预热池、冷启动、初始化脚本与文件系统快照克隆

2026-10-25 12:37–13:51（Asia/Shanghai）在共享的 ACS 集群（agent-platform，`sandbox-system`）上，用正式模板 `auto-story-v2` 的同一份 Pod 模板测了四条启动路径：从预热池领取、无库存冷启动、领取后执行初始化脚本、从文件系统快照克隆。目的是给 Environment 资源的“构建一次 → 快照 → 会话克隆”方案提供实测依据。

**结论：克隆的耗时基本固定在 26–29 s，大约等于一次冷启动加 2–4 s，与快照大小（366 MiB 和 1.57 GiB）关系不大。初始化脚本短于约 26 s 时，预热池加脚本更快；超过约 30 s 时，克隆更快。S1（业务层，约 25 s）两者几乎打平；S2（重依赖，约 4.5 min）克隆快 9 倍。** 但方案落地前有三个阻断问题必须先解决，详见“要点”的第 1–3 条：

1. 快照不会刷盘，最后几秒的写入可能丢失；
2. 克隆时传入的 `envs` 会被网关忽略；
3. 同一快照的所有克隆共用构建 Sandbox 的 envd 访问令牌。

本次只创建并删除了自己的测试资源（前缀 `oma-env-bench`，标签 `oma.dev/load-test=env-bench-20261025`），没有改动 `auto-story-v2`、`oma-scale-test-*`、gateway/manager、`oma-infra` 或 `oma-test`。清理后的核对结果见最后一节。

## 要点

1. **快照不会刷盘，最后几秒的写入可能丢失。** S2 的快照在 Checkpoint 创建前约 3 s 写入的内容全部没有进入克隆：5 个标记文件、`build-result.json` 都不存在，`rm -rf /opt/bench/dl` 也没有生效。之前写入的 pip 包和 apt 包都在。之后做了对照实验：先写出约 500 MB 脏页，再写几个小文件，然后立即创建快照。
   - 不执行 `sync`：克隆里没有这些小文件，`rm -rf` 没有生效，600 MiB 的大文件只剩 104 MiB，sha256 也对不上。
   - 先执行 `sync`（耗时 2.6 s）再创建快照：全部完整。
   - **快照只保证崩溃一致。** 构建流程必须在脚本结束后、创建快照前，由 Host 单独执行一次 `sync`。另外建议构建结束后先克隆一次，核对构建清单，通过后再把版本标为 ready。
2. **克隆时传入的 `envs` 被忽略，克隆拿到的是构建 Sandbox 当时的 `envs`。**
   - 实测：构建 Sandbox 传入 `BENCH_PLAIN=p1`；克隆时传入 `BENCH_PLAIN=p2` 和 `VFS_TOKEN=bench-override`。克隆内以 user、root 身份执行的命令和后台守护进程看到的都是 `p1`，`VFS_TOKEN` 未设置。
   - 网关源码：`prepareSandboxFromCheckpoint` 使用 Checkpoint 上保存的 `agents.kruise.io/init-runtime-request`（构建时的 envVars 和 accessToken）。请求里的 `EnvVars` 只在领取路径使用（`pkg/servers/e2b/create.go:155`）。
   - 可行的替代：`commands.run(..., { envs })` 按命令传入的环境变量在克隆上有效（实测 `p3`）。
   - Checkpoint 注解以明文保存构建时的 envs。**构建 Sandbox 不能传入任何密钥。**
3. **同一快照的所有克隆共用一个 envd 访问令牌。** 克隆 Sandbox CR 上的 `agents.kruise.io/runtime-access-token` 与 Checkpoint 中保存的 accessToken 相同，也就是构建 Sandbox 的令牌。S1 的第 6 个克隆和 S2 的 5 个克隆都核对过（只比较是否相等，没有输出值）。这是隔离方面的问题，需要向平台方确认或另行处理。
4. **Pod 模板里的 env 对 envd 命令不可见。** 从预热池领取、不传 `envs` 的 Sandbox 中，user 和 root 的命令都看不到 `VFS_TOKEN`。只有 PID 1（`bash /root/.jupyter/start-up.sh`）有 Pod 模板的 secretKeyRef 值。传入 `envs` 时，命令和守护进程看到的是传入的值。所以“create `envs` 是否覆盖 Pod 模板同名变量”的问题不成立：envd 命令的环境变量只来自 create `envs`（和按命令传入的 `envs`）。
5. **GitHub 直连不可用。** 在 Sandbox 内直连两个 release 地址，各试 2 次，4 次全部失败：1 次 HTTP/2 流在 90 s 后被重置，3 次连接超时（15 s）。改用 Host 注入的 `HTTPS_PROXY`（`sing-box.oma-infra.svc.cluster.local:7890`）后，3.6 MB 在 2.6 s 内下载完成。base-secret 的 `NO_PROXY` 只有 `localhost,127.0.0.1,::1,.svc,.cluster.local`。在正式服，如果初始化脚本不主动绕过代理，pip/apt/npm 流量也会经过 sing-box。
6. **快照本身很快，后台上传慢，但不影响使用。**
   - API 耗时 4.4–5.7 s（5 次），Checkpoint CR 从创建到 Succeeded 为 5 s。
   - 快照实际是一个 ECS 数据盘快照（50 GiB 盘，开启 InstantAccess）。完整大小：S1 384 MB，S2 1.68 GB。后台要 8–9 min 才完成。
   - 后台完成前克隆已可使用，S2 快照后约 3 min 就克隆成功。
7. **构建 Sandbox 的清理有坑。** `keep-running: false` 快照后，源 Sandbox 会进入 `Failed`（“All containers in pod have been paused”）。
   - 进入 Failed 之后再调用 E2B `kill`：网关日志 `sandbox is not viewable, just return success`，返回 true，但 CR 原样保留，直到 `shutdownTime`（本次是创建时间 + 30 min 超时 + 30 min 暂停保留）。
   - 快照返回后 1 s 内调用 `kill`，可以正常删除。
   - 正式服的暂停保留是 24 h，构建流程必须在快照返回后立即 `kill`，或者由 Host 直接删除 CR。

## 结果

### 启动路径（本机观测，毫秒；p50 / min / max）

| 路径 | n | create | firstCmd（`echo ok`） | 第二条命令 | 网关侧总耗时（p50） |
|---|---:|---|---|---|---|
| 预热池领取 | 5 | **135** / 110 / 262 | 200 / 166 / 279 | 34 / 21 / 49 | 30（WaitReady 0） |
| 无库存冷启动 | 3 | **24,567** / 23,981 / 27,743 | 339 / 188 / 390 | — | 24,540（WaitReady 24,497） |
| 预热 + S1 脚本：create | 3 | 192 / 177 / 192 | 191 / 147 / 211 | — | — |
| 预热 + S1 脚本：脚本 | 3 | **24,739** / 22,991 / 25,664 | — | — | Sandbox 内 24,676 |
| 预热 + S1 合计 | 3 | **25,063** / 23,394 / 26,047 | — | — | — |
| 预热 + S2 脚本：create | 3 | 219 / 215 / 228 | 181 / 166 / 334 | — | — |
| 预热 + S2 脚本：脚本 | 3 | **272,138** / 230,612 / 309,107 | — | — | Sandbox 内 272,098 |
| 预热 + S2 合计 | 3 | **272,687** / 231,006 / 309,507 | — | — | — |
| 快照 S1 | 1 | **5,492** | — | — | 5,423 |
| 快照 S2 | 1 | **5,654** | — | — | 5,441 |
| 克隆 S1 | 5 | **26,189** / 25,299 / 28,603 | 219 / 210 / 282 | 29 / 27 / 40 | 26,159（WaitReady 26,136） |
| 克隆 S2 | 5 | **28,864** / 24,259 / 31,004 | 235 / 210 / 308 | 39 / 25 / 46 | 28,838（WaitReady 28,812） |
| 克隆 S1 + Workspace CSI 挂载（附加） | 1 | 28,531 | 268 | — | 28,274（CSIMount 1,437，SecurityToken 108） |

- **合计的口径：** 预热 + 脚本的合计 = create + firstCmd + 脚本。克隆的 create + firstCmd 的 p50 是：S1 26,408 ms，S2 29,110 ms。
- **firstCmd 的组成：** 包含本机首次连接 `49983-<id>.<domain>` 的 TLS 握手，第二条命令只要 21–49 ms。
- **网关侧数据来源：** sandbox-manager 日志中的 `ClaimMetrics` / `CloneMetrics`。克隆和冷启动的耗时几乎全在 WaitReady，也就是新 Pod 就绪；PickAndLock、InitRuntime 都在 60 ms 以内。
- **预热池补货：** 每次领取后，池子要 25.5–31.8 s（p50 27.1 s）才补回 2 个。5 次预热领取前都确认池里有 2 个可用。
- **附加样本：**
  - 第 6 个 S1 克隆在删除源 Sandbox 之后创建，耗时 26,780 ms，说明快照不依赖源 Sandbox；
  - 1 个用于核查的 S2 克隆，耗时 25,391 ms；
  - 3 次 sync 实验的快照：5,524 / 4,376 / 5,536 ms，对应的克隆：24,682 / 24,949 / 28,652 ms。
- **试运行：** S1 和 S2 各有 1 次，不计入统计。S1 试运行发现脚本里的心跳子进程没有被清理，导致命令多挂了 5.5 s，修复后才开始正式样本。S2 试运行（修复后）为 131,974 ms，比正式样本快一倍，原因见“异常”第 3 条。

### S1 分步耗时（3 次，毫秒）

| 步骤 | 内容 | p50 | min | max |
|---|---|---:|---:|---:|
| vfs_cli | 经代理下载 GitHub release 3.6 MB，校验 sha256，解压，校验二进制 | 2,679 | 2,408 | 2,711 |
| mediakit_cli | 同上，3.0 MB | 2,797 | 2,521 | 3,047 |
| ossutil | 直连 `gosspublic.alicdn.com` 下载 10.5 MB zip，校验，解压 | 573 | 548 | 779 |
| venv | `/opt/venv/bin/python3 -m venv /opt/bench/venv` | 2,764 | 2,759 | 2,866 |
| pip_requirements | `pip install -r`（`google-genai==2.22.0`，共 25 个包，阿里云公网镜像） | 15,087 | 14,180 | 15,904 |
| verify | 运行 3 个 CLI 并 import genai | 487 | 472 | 493 |
| markers | 写标记文件，删除下载目录 | 39 | 39 | 41 |

- 所有下载都是第一次就成功，没有走到重试。
- 新增磁盘占用（`df` used，即 upper 层）：121 MB。

### S2 分步耗时（3 次，毫秒）

| 步骤 | p50 | min | max |
|---|---:|---:|---:|
| S1 部分（vfs / mediakit / ossutil / venv / pip） | 2,645 / 2,679 / 578 / 2,826 / 19,892 | — | — |
| pip_heavy：`scenedetect[opencv] pandas scipy matplotlib scikit-learn` | 161,064 | 128,981 | 184,621 |
| apt_update | 8,247 | 8,014 | 8,767 |
| apt_install：`libreoffice-core --no-install-recommends` | 72,276 | 65,945 | 83,065 |
| verify | 1,765 | 1,754 | 1,792 |

- 新增磁盘占用 1.08 GB（3 次一致）。
- 实际装上的版本：cv2 5.0.0、pandas 3.1.0、scipy 1.17.1、scikit-learn 1.9.1、scenedetect 0.7.2、LibreOffice 7.4.7。

### 快照与 Checkpoint

| | S1 | S2 |
|---|---|---|
| API 耗时 | 5,492 ms | 5,654 ms |
| Checkpoint CR | `phase: Succeeded`，创建到完成 5 s | 同左，5 s |
| CR 字段 | `spec.podName`（不是 `sandboxName`）、`keepRunning: false`、`persistentContents: [filesystem]`、`ttlAfterFinished: 6h`；注解 `checkpoint-mode: acs`、`init-runtime-request`（明文 envVars + accessToken）；`status.checkpointId` 为 `cp-…`。没有大小字段，也没有指向源 Sandbox 的 ownerReference | 同左 |
| 配套 SandboxTemplate | 与 Checkpoint 同名，ownerReference 指向 Checkpoint；保留了源 Sandbox 的标签，包括 `oma.dev/load-test` | 同左 |
| 底层 ECS 快照 | `aliyun_acs_sandbox_check_point_from_cp-uf600987gd3y5l7gspsj`：50 GiB data 盘，InstantAccess，**完整大小 383,778,816 B**，后台 8 min 完成 | `…cp-uf600987kmxfq1p44jqr`：**1,684,013,056 B**，后台 9 min 完成 |

- 大小来自只读的 `aliyun ecs DescribeSnapshots`。
- 快照只包含 overlay upper 所在的数据盘，不包含镜像层：S1 的快照大小远小于镜像中 `/opt` 2.8 GB 加 `/usr` 1.3 GB。
- 调用 `deleteSnapshot` 后，Checkpoint、SandboxTemplate 和 ECS 快照都一并删除了。

### 克隆内容核对

| 检查项 | S1 克隆（6 个） | S2 克隆（5 个 + 1 个核查） |
|---|---|---|
| `/opt/bench/bin/vfs-cli --version` | v0.3.18 | v0.3.18 |
| mediakit-cli / ossutil / genai | 0.2.1 / 2.2.0 / 2.22.0 | 同左 |
| `import cv2, pandas, scipy, sklearn, scenedetect`；`soffice.bin`；`dpkg` 状态 | — | 全部正常；`install ok installed`；`pip check` 和 `dpkg --audit` 没有报错 |
| 构建时写入的标记：`/opt`、`/tmp`、`/var/tmp`、`/root`、`/home/user` | **全部存在**，UUID 与构建时一致 | **全部不存在**（见要点 1） |
| 构建时启动的后台进程 | 不存在（以修正检查后的 #6 为准，见“异常”第 2 条）：克隆是重新启动的，uptime 约 3 s，jupyter 重新运行 | 不存在，uptime 约 6 s |
| hostname / Sandbox ID | `cp-<checkpointId>-<5 位>` | 同左 |

- **快照的覆盖范围：** `/tmp`、`/home/user`、`/root` 与 `/` 在同一个 overlay 上，都会被快照。所以构建脚本留在 `/tmp` 的临时文件（例如 `bench-curl-*.err`）、jupyter 运行时文件、用户家目录里的内容都会带进每个克隆。
- **S2 标记丢失的原因：** 不是路径问题，是刷盘问题。核查克隆中，构建期最新的文件是 `/var/lib/dpkg/status`（05:33:20.857Z，dpkg 会主动 fsync），而 Checkpoint 创建于 05:33:24Z；`/opt/bench/dl`（54 MB）和 apt 的 74 个 .deb 都还在。

### 刷盘对照实验

| 实验 | 快照前的脏页 | 克隆中的小文件 | 克隆中 `rm -rf` 是否生效 | 600 MiB 大文件 |
|---|---|---|---|---|
| 8 MiB 未 sync，约 1 s 后快照 | 约 8 MiB（估算，未测） | 存在 | — | 8 MiB，sha 一致 |
| 600 MiB 未 sync，立即快照 | 508 MB | **不存在**（`/opt`、`/tmp`、`/root`、`/home/user` 都不存在） | **未生效** | **只剩 104 MiB，sha 不一致** |
| 600 MiB，之后 `sync`（2,563 ms），再快照 | 0.3 MB | 存在 | 生效 | 完整，sha 一致 |

Sandbox 的写回参数：`vm.dirty_ratio=20`、`dirty_background_ratio=10`、`dirty_expire_centisecs=3000`、`dirty_writeback_centisecs=500`。

### 环境变量语义

| | 预热，传 `envs` {BENCH_PLAIN:p1, VFS_TOKEN:bench-override} | 预热，不传 `envs` | 克隆，传 {BENCH_PLAIN:p2, VFS_TOKEN:bench-override}，构建时为 p1 |
|---|---|---|---|
| user 命令 | p1 / `VFS_TOKEN = bench-override` | 未设置 / 未设置 | **p1** / **未设置** |
| root 命令 | p1 / bench-override | 未设置 / 未设置 | **p1** / **未设置** |
| `nohup` 后台守护进程 | p1 / bench-override | 未设置 / 未设置 | p1 / 未设置 |
| PID 1（Pod 模板 env） | 未设置 / 非空的 Pod 值 | 未设置 / 非空的 Pod 值 | 未设置 / 非空的 Pod 值 |
| 按命令 `envs` {BENCH_PLAIN:p3} | p3 | p3 | **p3** |

- 不传 `envs` 的克隆（S1 #2、S2 #2）和传了 p2 的克隆（S1 #3–6、S2 #3–5）看到的也都是 p1。
- 克隆 CR 的 `init-runtime-request.envVars` 只有 `{BENCH_PLAIN: p1}`。
- 报告中只记录了 `VFS_TOKEN` 是否等于 `bench-override`，没有记录原值。

### 镜像源和外网可达性（Sandbox 内，各 3 次）

| 目标 | 结果 |
|---|---|
| `getent hosts mirrors.cloud.aliyuncs.com` | 100.100.2.148、100.100.2.158（VPC 内网） |
| `http://mirrors.cloud.aliyuncs.com/pypi/simple/pip/` | 200，**22–31 ms** |
| `https://mirrors.aliyun.com/pypi/simple/pip/` | 200，87–110 ms（222.186.17.x） |
| `https://registry.npmmirror.com/express` | 200，206–379 ms |
| Debian `Release`：内网 / 公网镜像 | 29–94 ms / 114–127 ms |
| `https://pypi.org/simple/pip/` | 200，1.3–8.1 s |
| `https://github.com/` 和 release 地址直连 | **全部失败**：超时，或 HTTP/2 流被重置 |
| release 地址经 sing-box 代理 | 200，3.6 MB 用时 2.6 s |
| `gosspublic.alicdn.com`（ossutil） | 200，10.5 MB 用时 0.46 s |

## 结论

- **预热池 + S1 脚本 vs 克隆(S1)：** 25.1 s 对 26.4 s（p50，均含 firstCmd）。两者基本持平，预热池路径快约 1.3 s。S1 的耗时大头是 pip（15 s），它跟随镜像源速度波动。如果改用内网镜像，S1 可能更短，预热池路径的优势会更明显。
- **预热池 + S2 脚本 vs 克隆(S2)：** 272.7 s 对 29.1 s。克隆快 243 s，约 9.4 倍；而且 S2 脚本本身的耗时在 132–309 s 之间波动，克隆耗时稳定在 24–31 s。
- **交叉点：** 克隆的耗时与快照大小基本无关，S1 和 S2 只差约 2.7 s，大约等于“冷启动 + 2–4 s”。预热池路径的耗时约为 0.34 s 加脚本时长。所以：
  - 脚本时长约 **26–29 s** 时两者持平；
  - 脚本更短时，用预热池加脚本；
  - 脚本超过约 30 s 时，用克隆。
  - 预热池为空时，比较对象变成“冷启动 24.6 s + 脚本”。这时脚本只要超过约 2–4 s，克隆就更快。
- **对 Environment 设计的影响：**
  1. 构建流程是：脚本、单独执行 `sync`、快照、立即 `kill`，再克隆一次核对构建清单，最后标为 ready；
  2. 构建 Sandbox 不能传入密钥。会话的环境变量不能依赖克隆时的 create `envs`，需要改为按命令注入，或者写入受控的环境文件；
  3. 克隆共用访问令牌的问题需要先和平台方确认；
  4. 克隆目前无法预热，每个克隆都要新建 Pod。

## 异常与失败

1. **S1 快照的源 Sandbox 残留。** 第一次快照的 Checkpoint 查询脚本按 `spec.sandboxName` 过滤，但该字段实际为空，CR 用的是 `spec.podName`，于是轮询空等了 15 min。之后才调用 `kill`，这时源 Sandbox 已经是 Failed 状态，`kill` 成了空操作（见要点 7）。随后用 kubectl 删除了这个带本次标签的 CR。删除后再克隆（S1 #6）仍然成功。快照耗时由 SDK 直接测得，不受影响；Checkpoint 详情是之后补录的。
2. **进程检查误报。** S1 克隆 #1–5 的“后台进程存在”是误报：`pgrep -f` 匹配到了执行检查脚本的 bash 自身。修正匹配方式后，S1 #6 和全部 S2 克隆都确认进程不存在；uptime 2–6 s 也说明克隆是重新启动的。
3. **S2 脚本耗时波动大。** 试运行 132 s，正式 3 次为 231 / 272 / 309 s，主要差在 pip_heavy（72 s 对 129–185 s）和 apt_install（29 s 对 66–83 s），都走公网 `mirrors.aliyun.com`。没有进一步定位是镜像源带宽还是 Sandbox 的 CPU（2 vCPU）。
4. **vfs-cli 版本与仓库记录不一致。** 正式镜像 `67a46af6…` 中 `/usr/local/bin/vfs-cli` 是 **v0.3.21**，而 `sandbox/auto-story-v2/versions.json` 写的是 v0.3.18。本次 S1 按 versions.json 下载了 v0.3.18。
5. **没有出现失败。** 所有 create、脚本、快照、克隆都成功：共 39 次 E2B create（预热 20 次、冷启动 3 次、克隆 16 次），没有失败，下载也没有重试。

## 方法

- **集群与凭证：** agent-platform 集群，`kubectl --kubeconfig ~/.kube/agent-platform-config`。E2B 凭证使用 oma-test 的 key（team `sandbox-system`），从 `oma-test/oma-runner` 进程读入 `/tmp/oma-env-bench/cred.json`（权限 600），没有打印。
- **控制面：** `ack-sandbox-gateway:v0.3.0`（`sha256:0195c1e9…`）、`ack-sandbox-manager:v0.6.11`（`@sha256:89b9bad4…`）、`agent-runtime:v0.2.0`。
- **SDK 与驱动：** e2b SDK 2.24.0，是仓库打过补丁的版本（`server/node_modules/.pnpm/e2b@2.24.0_patch_hash=…`）。驱动脚本在本机用 node v23.7.0 运行，经公网 ALB 访问 `api.sandbox.agentry.welltop.tech`。本机 DNS 使用 fake-IP，单个新主机名解析只要 5–12 ms，所以没有加 DNS 缓存。
- **SandboxSet：** 读取线上的 `auto-story-v2`（resourceVersion 65639238），去掉 status、resourceVersion、uid 等字段，复制出两个：
  - `oma-env-bench-warm`（replicas 2）和 `oma-env-bench-cold`（replicas 0）；
  - Pod 模板与源完全相同：镜像 `oma-sandbox@sha256:67a46af66d3a53f4034b5c4d2c482a0b411718a3e923194bc547ab9528f3ba8d`，18 个 base-secret secretKeyRef env，`vfs-cli-policy-test-v1` 卷，runtimes `csi` + `agent-runtime`，`persistentContents: [filesystem]`，`enable-image-cache`，2C / 4Gi / 50Gi ephemeral；
  - 只额外加了模板标签 `oma.dev/load-test` 和注解 `oma.dev/test-only`。
- **create 参数（与 `e2b-sandbox-client.ts` 一致）：**
  - `claim-timeout-seconds` 和 `wait-ready-timeout-seconds` 都是 150；
  - lifecycle 为 `{onTimeout: 'pause', autoResume: false}`；
  - `timeoutMs` 30 min，`requestTimeoutMs` 185 s；
  - `reserve-paused-sandbox-duration` 缩短为 30m（正式为 24h），只为减少残留；
  - metadata 带 `oma.dev/load-test` 和 `label:oma.dev/load-test`；
  - 冷启动另加 `e2b.agents.kruise.io/create-on-no-stock: "true"`。网关默认值本来就是 true，见 `extensions.go` 中的 `CreateOnNoStock`；
  - 主测试中都不加 Workspace CSI 挂载。
- **脚本执行：**
  - 调用方式：`sandbox.commands.run(script, { user: 'root', cwd: '/home/user', timeoutMs: 1_800_000 })`；
  - 构建 Sandbox 统一传入 `envs` `{BENCH_PLAIN: 'p1'}`，用于之后核对克隆时的环境变量；
  - 计时：Sandbox 内用 `date +%s%3N` 记录每个步骤；本机测量整个 `commands.run`。两者相差不超过 70 ms；
  - 脚本每 15 s 输出一次心跳，防止流式连接空闲超时；
  - 磁盘占用在脚本前后单独测量，不计入脚本耗时；
  - 完整脚本见 JSON 中的 `initScript` 字段。
- **网络：** GitHub 的两个下载显式走 `--proxy http://sing-box.oma-infra.svc.cluster.local:7890`。这是 Host 从 base-secret 注入给每个 Sandbox 的代理，代表正式服的网络路径，因为直连已确认不可用。ossutil、pip 和 apt 都直连阿里云。测试 Sandbox 没有设置任何代理环境变量。
- **快照：** 用的 header 与 2026-10-10 生命周期验证脚本相同，keep-running 改为 false，TTL 6h，wait-success 170 s。快照分别在第 3 次 S1 和第 3 次 S2 脚本结束后几秒内创建（中间只做了磁盘占用测量），没有 `sync`。
- **顺序与并发：** 所有样本串行执行。同时存活的已领取测试 Sandbox 最多 2 个，加上预热池 2 个，始终不超过 8 个。

## 没有验证的部分

- **集群内 Runner 的链路**（`E2B_SANDBOX_URL` 直连 sandbox-manager）。create 和 firstCmd 包含本机经 ALB 的往返，约 0.1–0.2 s；克隆和冷启动的数量级不受影响。
- **并发。** 同时冷启动或克隆多个 Sandbox 时 WaitReady 会怎样变化；ACS 2000 vCPU 配额与正式服共用。
- **内网镜像** `mirrors.cloud.aliyuncs.com` 下的 pip/apt 大批量安装速度。只测了索引页延迟，内网比公网快 3–4 倍。
- **基于快照的预热池。** kruise 提案中有 `x-e2b-kruise-auto-warm`（为 Template Build 创建伴生 SandboxSet），也可以考虑让 SandboxSet 通过 templateRef 引用 Checkpoint 生成的 SandboxTemplate。都没有验证当前部署版本是否支持。
- **`sync` 是否足够。** 本次只证明了“`sync` 后完整”，`fsfreeze` 等更强的手段没有测。
- **快照 TTL 到期后的行为。** 本次都是主动删除。
- **内存快照。** 没有测 `persistent-contents` 包含 memory 的情况。
- **Workspace 挂载克隆只做了 1 次。** 前缀是 `env-bench-20261025/csi-clone-probe/`，不是真实的 oma-test 租户。挂载成功：`/home/user/workspace` 指向 `/run/csi/mount-root/oss/<hash>`，类型 fuseblk；只读检查，没有写入，该前缀下 0 个对象。

## 复现

驱动脚本只保存在本机 `/tmp/oma-env-bench/`，没有放进仓库：

- `lib.mjs`：公共函数；
- `create-bench.mjs warm|cold N`：预热和冷启动样本；
- `run-script.mjs S1|S2 i [--snapshot]`：脚本样本和快照；
- `clone.mjs S1|S2 N [start]`：克隆样本；
- `env-warm.mjs`：预热 Sandbox 的环境变量测试；
- `sync-experiment*.mjs`：刷盘对照实验；
- `clone-forensics.mjs`：核查克隆内容的时间点；
- `csi-clone.mjs`：带 Workspace 挂载的克隆；
- 初始化脚本 `init.sh` 的全文也保存在 JSON 中。

逐个样本的数据（包括 manager 的 Claim/CloneMetrics、Sandbox CR 状态和 ledger）见 [JSON 证据](environment-snapshot-bench-2026-10-25.json)。写出前已检查：不含 E2B key，Checkpoint 中的 accessToken 已替换为 `<redacted>`。

## 清理

- **过程：**
  1. 所有 Sandbox 都通过 E2B `kill` 删除（39 次）；S1 快照的源 Sandbox 是用 kubectl 删除的（见“异常”第 1 条）。
  2. 5 个 Checkpoint 都用 `Sandbox.deleteSnapshot` 删除：S1、S2，以及 3 次 sync 实验；配套的 SandboxTemplate 随之被回收。
  3. 两个 SandboxSet 先缩到 0，再删除；它们的修订版 SandboxTemplate 一并删除。
- **核对结果（2026-10-25T05:51Z）：**

```text
$ kubectl --kubeconfig ~/.kube/agent-platform-config -n sandbox-system get sandboxset -l oma.dev/load-test=env-bench-20261025
No resources found in sandbox-system namespace.
$ ... get sandbox -l oma.dev/load-test=env-bench-20261025
No resources found in sandbox-system namespace.
$ ... get sandboxset --no-headers | grep -c oma-env-bench
0
$ ... get sandbox --no-headers | grep -c -E "oma-env-bench|cp-uf600987"
0
$ ... get checkpoint --no-headers | grep -c oma-env-bench
0
$ ... get sandboxtemplate --no-headers | grep -c oma-env-bench
0
$ ... get pods --no-headers | grep -c -E "oma-env-bench|cp-uf600987"
0        # 2 warm-pool pods were Terminating for ~20 s after the SandboxSet deletion, then 0
$ aliyun ecs DescribeSnapshots --RegionId cn-shanghai --PageSize 100   # filter aliyun_acs_sandbox_check_point_from_cp-uf600987*
total region snapshots: 8 bench checkpoint snapshots remaining: 0
$ aliyun oss ls oss://agentry/env-bench-20261025/ --region cn-shanghai
Object Number is: 0
$ ... get sandboxset
auto-story-v2             8     8     8     8     f9bfdfdfb    41d
oma-scale-test-20261021   0     0                 6c789cb6fb   4d1h
oma-scale-test-20261022   0     0                 6d889fd9c5   3d11h
```

- **本机：** `/tmp/oma-env-bench/` 中的凭证文件和 Checkpoint YAML（含 accessToken）已删除，均没有进入仓库；驱动脚本和已脱敏的样本仍保留在该目录。
