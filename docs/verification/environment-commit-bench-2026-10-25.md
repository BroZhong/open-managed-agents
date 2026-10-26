# Environment 启动路径基准（二）：ACS Commit 制作镜像，领取预热池时原地换镜像

2026-10-25 14:43–15:37（Asia/Shanghai）在共享的 ACS 集群（agent-platform，`sandbox-system`）上验证另一条 Environment 落地路径：在构建 Sandbox 里执行初始化脚本，用 ACS Commit 把容器提交成镜像推到 ACR；会话从共用的基础预热池领取 Sandbox，同时通过 `e2b.agents.kruise.io/image` 把容器原地换成该镜像。结果与上一份 [文件系统快照克隆基准](environment-snapshot-bench-2026-10-25.md) 对比。

**结论：ACS Commit 在 `agent-sandbox` 计算类上可用。克隆方案的三个阻断问题在这条路径上都不存在：每次领取的 envd 令牌都不同，create `envs` 生效，不执行 `sync` 也能完整保留最后写入的文件。但按正式模板（`terminationGracePeriodSeconds: 30`）换镜像要 35–54 s，比克隆（26–29 s）慢。其中 30 s 花在等旧容器退出：PID 1 是 `bash /root/.jupyter/start-up.sh`，旧容器每次都要等宽限期结束、被 SIGKILL 后才退出。宽限期改成 2 s 后，S1 换镜像只要 6.5 s（镜像不带 600 MiB 测试文件），带测试文件为 15.8 s；S2（带测试文件）为 27.4 s。也就是说，轻环境比克隆快约 4 倍，重环境与克隆持平。除去固定开销，换镜像的耗时与新增层的大小成正比（约 45–80 MB/s），ImageCache 可以省掉这部分。**

本次只创建并删除了自己的测试资源：前缀 `oma-env-bench-commit` 的 SandboxSet、Commit 和 ImageCache，以及临时私有 ACR 仓库 `welltop/oma-env-bench`，标签都是 `oma.dev/load-test=env-commit-20261025`。没有改动 `auto-story-v2`、`oma-scale-test-*`、gateway/manager、`oma-infra` 或 `oma-test`。清理核对见最后一节。

## 要点

1. **Commit 在 `agent-sandbox` 计算类上可用，但构建要多花 1.5–3.7 min。**
   - 3 次 Commit 全部 `Succeeded`，没有 Events，也没有失败。从 `status.startTime` 到 `completionTime`：S1 135 s，S2 194 s，S1NB 87 s。依次分为 PullBaseImage 16–18 s、CommitContainer 66–138 s、Push 5–38 s 三段。
   - 从本机创建 CR 到看到 `phase: Succeeded` 为 102–223 s。`phase` 比 `completionTime` 晚 13–29 s 才更新（2 s 轮询）。
   - 对比：快照 API 只要 5.5 s。
   - Pod 必须在创建时带 `image.alibabacloud.com/enable-commit: "true"`，所以需要一个单独的构建 SandboxSet。
   - CRD 有 `spec.registryAuth.secrets`（同命名空间的 dockerconfigjson Secret 名），文档里没提。本次 Pod 的 `imagePullSecrets` 和 Commit 的 `registryAuth.secrets` 都设成了 `ali-shanghai`，这个 Secret 有推送权限。
   - Commit 不影响构建 Sandbox：提交后仍可正常执行命令，随后 `kill` 立即生效。不存在快照路径“进入 Failed 后 kill 成空操作”的问题。
2. **镜像配置与基础镜像完全一致，Pod 的 env 没有写进镜像。**
   - 三个镜像的 `Env`（32 个变量名）、`Entrypoint`（`bash /root/.jupyter/start-up.sh`）、`Cmd`、`WorkingDir`、`User`、`Labels` 都与基础镜像逐项相同。
   - 构建 Pod 的哨兵变量 `BENCH_POD_ENV`、agent-runtime 注入的 `ENVD_DIR`/`GODEBUG`/`POD_UID` 都不在镜像配置里。history 只多了一条，`created_by: "bash /root/.jupyter/start-up.sh"`。
   - 镜像结构：65 层与基础镜像共用（digest 相同），只新增 1 层。新层大小：S1 637.7 MiB，S2 940.4 MiB，S1NB 37.5 MiB。
3. **容器根文件系统里的内容会原样进入镜像，并被推到 ACR。** 列出了 S1 新增层的 4,867 个条目（只读名字和大小），结果：
   - 包含 `/opt/bench`、`/tmp`、`/var/tmp`、`/root` 下的标记和临时文件。
   - 包含构建时 Jupyter 留下的运行时文件：`/home/user/.local/share/jupyter/runtime/` 下的 `jupyter_cookie_secret`、`jpserver-9.json`、两个 `kernel-*.json` 连接文件，以及 `/home/user/.ipython/.../history.sqlite`。
   - 包含 `/run/e2b/.E2B_SANDBOX`（5 B）和 0 字节的 `/etc/hosts` 占位文件。
   - 运行时挂载点（`/mnt/envd`、`/run/agent-runtime`、`/run/agent-helper`、`/run/csi/mount-root`、`/var/opt/sandbox/agent-token`）只是空目录。镜像里没有 envd 令牌，也没有运行时文件。
   - 构建前删掉的 `/root/.cache` 和 `/home/user/.cache/pip` 以 whiteout 形式出现。
   - **影响：** 初始化脚本写到磁盘上的任何密钥都会进入镜像。同一镜像的所有 Sandbox 共用同一个 Jupyter cookie secret。镜像所在的 `welltop` 命名空间放着公司全部镜像，持有 `ali-shanghai` 凭证的人都能拉取。
4. **按正式模板换镜像时，耗时大头是 30 s 宽限期。** 根据 k8s 事件（1 s 精度）分解，每次换镜像依次经过：
   - 领取后 0.4–3.5 s 出现 `Killing: Container sandbox definition changed`；
   - 旧容器在宽限期满时以 exit 137 退出，18 次全部如此（宽限期 30 s 时为 30–31 s，2 s 时为 2 s）；
   - 约 2 s 后开始拉取新镜像；
   - 拉取并启动新容器：S1NB 0–2 s，S1 8–11 s，S2 19–23 s；
   - 再过约 1–2 s，create 返回。
   `推断`：`start-up.sh` 来自上游基础镜像，没有处理 SIGTERM；内核不会对 PID 1 执行 SIGTERM 的默认动作，所以 SIGTERM 不起作用。宽限期改为 2 s 后，固定开销约为 5 s。
5. **拉取耗时与新增层大小成正比，ImageCache 可以省掉拉取。**
   - 不用缓存时，637.7 MiB 拉取并启动用 8–11 s，940.4 MiB 用 19–23 s。
   - 使用 ImageCache 并设置 `ops.alibabacloud.com/update-with-image-cache: "true"` 后，换镜像时没有 `Pulling` 事件，旧容器退出后同一秒新容器就启动了。S1 的 create 从 42.8 s 降到 35.2 s，与 37.5 MiB 的 S1NB 持平。
   - 代价有两项：
     - 每个镜像版本创建缓存要 4 min 18 s。
     - 带这个注解的池子扩容时没有用基础镜像的缓存：没有 `ImageCacheHit`，完整拉取 1.87 GB 用了 78.5 s 和 79.7 s，补货约 110 s。普通池只要约 30–45 s。
6. **克隆方案的三个阻断问题都不存在。** 2 个基线 Sandbox 和 18 个换镜像 Sandbox 的核对结果：
   - envd 令牌两两不同，也都不等于 3 个构建 Sandbox 的令牌。比较时只比是否相等。
   - create 时传入的 `BENCH_PLAIN=p2` 在 user、root 命令和 `nohup` 守护进程里都生效。构建时传入的 `BENCH_BUILD_ENV=b1` 不会带过来。
   - 构建时在创建 Commit 前约 3–4 s 写完 600 MiB 随机文件（之后只算了 sha256），创建 Commit 时 Dirty 约 445 MiB，没有执行 `sync`。所有带 big.bin 的 Sandbox（S1 8 个、S2 5 个）里文件大小和 sha256 都一致，8 个标记文件全部存在。对比：克隆在同样条件下只剩 104 MiB，sha 也对不上。
7. **换镜像后得到的是一个全新启动的容器。** uptime 只有 2.1–8.5 s（基线预热 Sandbox 等于 Pod 年龄，约 706 s），构建时留下的后台进程不存在，PID 1 是重新启动的 `start-up.sh`。PID 1 的环境变量仍然来自池子的 Pod 模板，包含 base-secret 的 `VFS_TOKEN`、`OSS_READ_ACCESS_KEY_*` 等。这一点和以前一样，root 可以读到。
8. **Workspace CSI 挂载在换镜像后可用。** `/home/user/workspace` 指向 `/run/csi/mount-root/oss/<hash>`，类型为 fuseblk。CSIMount 耗时 2,588 ms，SecurityToken 耗时 221 ms。

## 结果

### 启动路径（本机观测，毫秒；p50 / min / max；n=2 时 p50 取两次的均值）

| 路径 | n | create | firstCmd（`echo ok`） | create + firstCmd p50 | 网关 WaitReady p50 |
|---|---:|---|---|---:|---:|
| 预热领取，不换镜像 | 2 | **160** / 114 / 207 | 158 / 157 / 158 | 318 | 0 |
| 换成 S1 镜像（宽限期 30 s） | 3 | **42,835** / 42,332 / 46,173 | 303 / 238 / 311 | 43,073 | 42,707 |
| 换成 S2 镜像（宽限期 30 s） | 3 | **53,866** / 53,678 / 54,435 | 294 / 209 / 371 | 54,160 | 53,759 |
| 换成 S1 镜像 + ImageCache（宽限期 30 s） | 2 | **35,188** / 34,889 / 35,487 | 234 / 218 / 251 | 35,422 | 34,929 |
| 附加：换成 S1NB（不含 big.bin，宽限期 30 s） | 2 | 35,192 / 34,308 / 36,077 | 231 / 203 / 259 | 35,424 | 34,998 |
| 附加：换成 S1NB（宽限期 2 s） | 3 | **6,537** / 6,276 / 7,509 | 292 / 261 / 339 | 6,876 | 6,234 |
| 附加：换成 S1（宽限期 2 s） | 2 | **15,768** / 15,692 / 15,844 | 396 / 327 / 465 | 16,164 | 15,554 |
| 附加：换成 S2（宽限期 2 s） | 2 | **27,400** / 25,356 / 29,443 | 300 / 184 / 417 | 27,700 | 27,166 |
| 换成 S1 + Workspace CSI 挂载（宽限期 30 s） | 1 | 46,486 | 210 | 46,696 | 43,142（CSIMount 2,588） |
| *上一份报告：预热领取* | 5 | 135 / 110 / 262 | 200 | — | 0 |
| *上一份报告：冷启动* | 3 | 24,567 / 23,981 / 27,743 | 339 | — | 24,497 |
| *上一份报告：克隆 S1* | 5 | 26,189 / 25,299 / 28,603 | 219 | 26,408 | 26,136 |
| *上一份报告：克隆 S2* | 5 | 28,864 / 24,259 / 31,004 | 235 | 29,110 | 28,812 |
| *上一份报告：预热 + S1 脚本合计* | 3 | 25,063（脚本 24,739） | — | — | — |
| *上一份报告：预热 + S2 脚本合计* | 3 | 272,687（脚本 272,138） | — | — | — |

- **镜像大小：** S1 和 S2 都带了 600 MiB 的随机文件 `/opt/bench/big.bin`（压缩后约 629 MB），用来检查不 sync 时的完整性。上一份报告的克隆 S1/S2 没有这个文件。S1NB 是同一个 S1 脚本、但不写 big.bin 的镜像，用来做公平对比。
- **宽限期 2 s 的池子：** `oma-env-bench-commit-pool-tg` 与 `auto-story-v2` 的模板只差 `terminationGracePeriodSeconds: 2`。S1NB 和宽限期 2 s 的两组都是看到前面的结果后追加的，不在原计划里。
- **网关侧耗时：** 换镜像的耗时几乎全在 WaitReady，也就是原地更新完成到 Pod 就绪。PickAndLock 为 8–17 ms，InitRuntime 为 27–171 ms（带 CSI 的一次为 312 ms）。
- **预热池库存：** 所有换镜像样本领取前都有可用的预热副本，没有一次退化成冷启动。基础池每次领取前都是 2/2。宽限期 2 s 的池子有 3 次是 1/2，因为驱动对非默认池只要求至少 1 个可用。ImageCache 池是 1/1。
- **firstCmd：** 换镜像后的 firstCmd 为 184–465 ms，比基线略高。因为新容器刚启动，firstCmd 包含首次 TLS 握手；第二条命令为 25–61 ms。

### 换镜像的时间分解（秒，k8s 事件精度 1 s）

| 路径 | 领取 → Killing | Killing → 旧容器退出（137） | 退出 → 开始拉取 | 拉取 → 新容器启动 | create 返回 |
|---|---|---|---|---|---|
| S1，宽限期 30 s | 0.4–1.9 | 30–31 | 2 | 8–11 | 42.3–46.2 |
| S2，宽限期 30 s | 1.1–2.3 | 30 | 2 | 19–20 | 53.7–54.4 |
| S1NB，宽限期 30 s | 1.2–1.5 | 30 | 2 | 0–2 | 34.3–36.1 |
| S1 + ImageCache，宽限期 30 s | 2.8–3.5 | 31 | 没有 Pulling 事件 | 0（退出的同一秒启动） | 34.9–35.5 |
| S1NB，宽限期 2 s | 1.0–1.4 | 2 | 2 | 0–1 | 6.3–7.5 |
| S1，宽限期 2 s | 1.3–1.4 | 2 | 2 | 9 | 15.7–15.8 |
| S2，宽限期 2 s | 0.9–2.0 | 2 | 2 | 19–23 | 25.4–29.4 |

近似公式：create ≈ 1.5 s + 宽限期 + 2 s + 新增层拉取时间 + 1–2 s。按 S2 新层去掉 big.bin 后约 357 MB 估算，宽限期 2 s 时 S2 换镜像约 10–13 s。这只是估算，没有实测。

### Commit 与镜像

| | S1 | S2 | 附加：S1NB |
|---|---|---|---|
| 初始化脚本 | 33,594 ms | 473,694 ms | 65,455 ms |
| 清理 + 标记 + big.bin | 5,576 ms | 5,575 ms | 216 ms（不写 big.bin） |
| 创建 Commit 时的 Dirty | 445 MiB | 446 MiB | 56 MiB |
| Commit：创建 → 观测到 `Succeeded` | 161.1 s | 223.5 s | 102.1 s |
| Commit：`startTime` → `completionTime` | 135 s | 194 s | 87 s |
| 其中 PullBaseImage / CommitContainer / Push | 18 / 90 / 27 s | 18 / 138 / 38 s | 16 / 66 / 5 s |
| 镜像 digest（docker v2 manifest） | `sha256:b380f3c3…` | `sha256:76d8dd65…` | `sha256:37e8f585…` |
| 层数 | 66 = 基础镜像 65 层 + 1 层 | 同左 | 同左 |
| 新层（压缩后） | 668,645,364 B（637.7 MiB） | 986,033,445 B（940.4 MiB） | 39,307,216 B（37.5 MiB） |
| 镜像总大小（manifest 各层加 config） | 2,543,546,197 B | 2,860,934,278 B | 1,914,208,047 B |
| Commit 报告的 image size / usage | 2,543,560,804 / 5,504,307,200 | 2,860,948,885 / 6,446,227,456 | 1,914,222,653 / 4,875,157,504 |

- **基础镜像：** `welltop/oma-sandbox@sha256:67a46af6…`（OCI index），对应 amd64 manifest `sha256:0f82d36a…`：65 层，1,874,900,661 B。新层的 mediaType 为 `application/vnd.docker.image.rootfs.diff.tar.gzip`。
- **Commit 阶段耗时与新层大小：** CommitContainer 阶段 66–138 s，即使新层只有 37.5 MiB 也要 66 s，说明这一段有不小的固定开销。Push 阶段 5–38 s，三次都约 25 MB/s 乘以新层大小；`推断`：基础层没有重新上传。
- **ACR 中的 tag：** `s1-20261025-0647`、`s2-20261025-0654`、`s1nb-20261025-0715`，status 都是 NORMAL。
- **S2 脚本变慢：** 本次 S2 脚本用了 474 s（上一份报告 p50 为 272 s），pip_heavy 用 255 s，apt_install 用 169 s。S1NB 的 pip 用 55.7 s（S1 为 23.4 s）。三者都走公网镜像 `mirrors.aliyun.com`，耗时波动与上一份报告“异常”第 3 条相同。

### S1 新增层内容（4,867 个条目，只列名字和大小）

| 路径 | 内容 |
|---|---|
| `/opt/bench` | 4,791 个条目，738 MB：venv、3 个 CLI、`build-result.json`、标记文件、`big.bin`（629,145,600 B） |
| `/home/user` | `.ipython/profile_default/history.sqlite`，`.local/share/jupyter/runtime/`（`jupyter_cookie_secret`、`jpserver-9.json`、`jpserver-9-open.html`、2 个 `kernel-*.json`），标记文件 |
| `/root` | `.server/` 下 Jupyter server 的 `__pycache__`（24 个），标记文件；whiteout `.wh..cache` |
| `/tmp`、`/var/tmp` | 标记文件，3 个空的 `bench-curl-*.err`；换镜像后的 Sandbox 里还能看到构建时的 `tmp…_kernels` 目录 |
| `/run/e2b/.E2B_SANDBOX` | 5 B |
| `/etc/hosts` | 0 B，挂载点占位 |
| 运行时挂载点 | `/mnt/envd`、`/run/agent-runtime`、`/run/agent-helper`、`/run/csi/mount-root`、`/var/opt/sandbox/agent-token` 都是空目录 |
| whiteout | `root/.wh..cache`、`home/user/.cache/.wh.pip` |

### 正确性核对（18 个换镜像 Sandbox）

| 检查项 | S1（8 个：3 + 宽限期 2 s 2 + ImageCache 2 + CSI 1） | S2（5 个：3 + 宽限期 2 s 2） | S1NB（5 个：2 + 宽限期 2 s 3） |
|---|---|---|---|
| vfs-cli / mediakit-cli / ossutil / genai | v0.3.18 / 0.2.1 / 2.2.0 / 2.22.0 | 同左 | 同左 |
| cv2、pandas、scipy、sklearn、scenedetect；soffice；dpkg | — | 5.0.0 / 3.1.0 / 1.17.1 / 1.9.1 / 0.7.2；`soffice.bin` 存在；`install ok installed 4:7.4.7-1+deb12u14`；`dpkg --audit` 无报错 | — |
| 标记文件：`/opt`、`/tmp`、`/var/tmp`、`/root`、`/home/user` 下的构建标记，3 个 Commit 前写的标记 | 8/8 存在，UUID 与构建时一致 | 8/8 存在 | 8/8 存在 |
| `big.bin`（不 sync） | 629,145,600 B，sha256 一致 | 一致 | 不存在（符合预期） |
| `/opt/bench/dl`、`/root/.cache` | 不存在（构建时删除的内容保持删除状态） | 同左 | 同左 |
| 构建时启动的后台进程 | 不存在 | 不存在 | 不存在 |
| 运行中的镜像（Pod `imageID`） | `…oma-env-bench@sha256:b380f3c3…`，restartCount 1，`InplaceUpdate=Succeeded` | `…@sha256:76d8dd65…` | `…@sha256:37e8f585…` |
| PID 1 环境中有 `BENCH_POD_ENV` | 没有 | 没有 | 没有 |

### 环境变量与令牌语义

| | 克隆（上一份报告） | 换镜像（本次） |
|---|---|---|
| create `envs` `{BENCH_PLAIN: p2}`：user / root / `nohup` 守护进程 | **p1**（构建时的值）/ p1 / p1 | **p2** / p2 / p2（18/18） |
| 构建时的 create `envs`（`BENCH_BUILD_ENV=b1`） | 带进每个克隆 | **不带过来**（18/18 未设置） |
| 按命令传入 `envs` `{BENCH_PLAIN: p3}` | p3 | p3（20/20，含基线） |
| Pod 模板 env（构建 Pod 的 `BENCH_POD_ENV`） | — | 不在镜像配置里，也不在 PID 1 中 |
| envd 令牌 | 所有克隆共用构建 Sandbox 的令牌 | 每次领取都不同，也都不等于构建 Sandbox 的令牌（20 个两两比较，只比是否相等） |
| SDK `envdAccessToken` 与 CR 注解 `agents.kruise.io/runtime-access-token` | — | 每个都相等 |

### ImageCache（S1 镜像）

| | 结果 |
|---|---|
| 创建 | `aliyun acc create-image-cache`，镜像为 `registry-vpc…/welltop/oma-env-bench@sha256:b380f3c3…`，网络配置与集群 Pod 相同（`sg-uf6bikdzvy9di9y8wp89` 和 3 个 vSwitch），没有传镜像凭证 |
| 耗时 | 07:25:50Z 创建，07:30:08Z Ready（4 min 18 s）；拉取 2 min，构建缓存 1 min 54 s；Size 6 |
| 池子 `oma-env-bench-commit-pool-ic` | 模板与 `auto-story-v2` 相同，只多了 `ops.alibabacloud.com/update-with-image-cache: "true"`；replicas 1 |
| 池子扩容 | 2 个 Pod 都没有 `ImageCacheHit`，也没有 `matched-image-caches` 注解；基础镜像完整拉取用了 78.5 s 和 79.7 s。普通池的 Pod 会命中基础镜像缓存 `imc-uf6c2ys46pzt3c3grd74` |
| 换镜像 | 没有 Pulling 事件；create 35.2 s（S1 不用缓存为 42.8 s） |

## 结论

**(a) 轻环境 S1：**
- 按当前正式模板（宽限期 30 s），Commit + 换镜像比克隆和“预热 + 脚本”都慢。
  - 本次 S1：42.8 s，镜像带 600 MiB 测试文件；S1NB 不带测试文件，为 35.2 s。
  - 上一份报告：克隆 26.2 s，预热 + 脚本 25.1 s。
- 把宽限期降到 2 s 后，S1NB 只要 6.5 s（create + firstCmd 6.9 s），比克隆（26.4 s）快 3.8 倍，比“预热 + 脚本”（25.1 s）快 3.6 倍。
- 优势不止速度：换镜像从共用的基础预热池领取，克隆则每次都要新建 Pod。
- 所以 S1 用 Commit 路径的前提是：先把基础池模板的宽限期调短，或者让 `start-up.sh` 正确处理 SIGTERM。

**(b) 重环境 S2：**
- 宽限期 30 s 时 53.9 s，比克隆（28.9 s）慢，但仍比每次执行脚本（272–474 s）快 5–9 倍。
- 宽限期 2 s 时 27.4 s，与克隆持平，而且镜像里多了 629 MB 的测试文件。去掉测试文件后估计约 10–13 s（未实测）。
- 拉取耗时与新层大小成正比，ImageCache 能省掉这一段，S1 已实测。
- 重环境用 Commit 路径的条件：调短宽限期；体积大的版本可选 ImageCache，但要接受 4 min 以上的缓存构建时间，以及带缓存注解的池子扩容变慢。

**克隆方案的三个阻断问题是否解决：都解决了。**
1. **共用令牌：** 每次领取都由网关重新初始化 envd，令牌两两不同（20 个），也都不等于构建 Sandbox 的令牌。镜像里没有令牌文件。
2. **envs 被忽略：** 换镜像走的是普通领取路径，create `envs` 生效；构建时的 envs 不会带过来。会话密钥可以继续按 create `envs` 注入。
3. **崩溃一致：** Commit 前约 445 MiB 脏页、不执行 `sync`，13 个带 big.bin 的 Sandbox 中文件全部完整、sha 一致，Commit 前最后写入的标记也都存在。`推断`：Commit 从容器内视角读取文件，而不是对块设备做快照。实测不需要额外 `sync`。

**新增的代价和风险：**
- 构建更慢：Commit 87–194 s，`phase` 还要再晚 13–29 s 才更新；快照只要 5.5 s。Environment 构建是一次性的，可以接受。
- 镜像落在 ACR：
  - 每个版本新增一层，37 MB–1 GB。需要独立的命名空间或仓库、明确拉取权限和版本回收，不能放在全公司共用的 `welltop` 下。
  - 根文件系统里的一切都会进镜像。构建流程在 Commit 前必须清理 `/tmp`、Jupyter 运行时目录（cookie secret、kernel 连接文件）和 `/run/e2b`。构建 Sandbox 不能带密钥（本次已移除 18 个 secretKeyRef），初始化脚本也不能把密钥写到磁盘。
- 基础池模板需要修改：要么调短 `terminationGracePeriodSeconds`，要么修改镜像的 PID 1 信号处理。前者也会缩短 Sandbox 删除时的退出宽限，影响需要另行评估。

**对 Environment 设计的建议：**
1. 构建：单独的构建 SandboxSet（enable-commit、无密钥）→ 初始化脚本 → 清理运行时残留 → Commit → 等待 `Succeeded` → 用 digest 领取一次核对构建清单 → 标为 ready。
2. 会话：从基础池领取，带上 `e2b.agents.kruise.io/image: <repo>@<digest>`，密钥通过 create `envs` 注入。
3. 体积大的版本可以配 ImageCache，但缓存池的扩容会变慢，要权衡。

## 异常与失败

1. **旧容器每次都等满宽限期才被 SIGKILL。** 18 次换镜像的旧容器全部以 exit 137 退出，耗时正好等于宽限期（30 s 或 2 s）。这是本次耗时的主要来源，不是偶发问题。
2. **Commit 的 `phase` 更新滞后。** 3 次都在 `completionTime` 之后 13–29 s 才变成 `Succeeded`。期间我另起的轮询仍看到 `Running`。
3. **PullBaseImage 条件里的警告。** 3 次的消息都是 `Pull base image for container sandbox successfully; Warning: The container image tag was overwritten.`，但目标 tag 都是新的。含义不明，没有发现实际影响。
4. **带 `update-with-image-cache: "true"` 的池子扩容没有命中缓存。** 见 ImageCache 小节，2 个 Pod 都是完整拉取。
5. **驱动的标记检查最初写错了。** S1 的 3 个样本中 `markersMatchBuilder: false`，是因为检查逻辑错误地要求“构建标记”和“Commit 前的标记”UUID 相同，而它们本来就是两次生成的。修正后的检查用于其余样本。S1 的 3 个样本按原始输出重新核对：8 个标记都在，两组 UUID 各自一致，Commit 前的标记与构建时记录的值一致。
6. **初始化脚本耗时波动。** 见“Commit 与镜像”小节。只影响构建时间，不影响换镜像。
7. **没有出现失败。** 23 次 E2B create（构建 3 次、基线 2 次、换镜像 18 次）、3 次 Commit、1 次 ImageCache 全部成功，所有 kill 后 CR 都已消失。

## 方法

- **集群与凭证：**
  - 集群为 agent-platform，`kubectl --kubeconfig ~/.kube/agent-platform-config`。
  - E2B 使用 oma-test 的 key，从 `oma-test/oma-runner` 进程读入 `/tmp/oma-env-commit/creds.json`（权限 600），没有打印。
  - 访问 registry API 时，从 `sandbox-system/ali-shanghai` 解码出用户名和密码，写入同目录下权限 600 的文件，只用于 registry v2 API，结束后删除。
- **控制面：** `ack-sandbox-gateway:v0.3.0`、`ack-sandbox-manager:v0.6.11`、ack-agent-sandbox-controller v0.6.6-release.1、`agent-runtime:v0.2.0`。
- **SDK：** e2b SDK 2.24.0，仓库打过补丁的版本，按绝对路径 import。本机 node v23.7.0，经公网 ALB 访问。
- **SandboxSet：** 都从线上 `auto-story-v2`（resourceVersion 65752388，generation 20）复制，去掉 status/uid/resourceVersion，加上本次标签和注解。
  - `oma-env-bench-commit-builder`（replicas 1）：加 `image.alibabacloud.com/enable-commit: "true"`；删除全部 18 个 secretKeyRef env；新增 `BENCH_POD_ENV=sentinel-builder`。`imagePullSecrets` 原本就是 `ali-shanghai`。模板里本来没有 `source.env` secret 卷，只有 `vfs-cli-policy` ConfigMap 卷，保留了。
  - `oma-env-bench-commit-pool`（replicas 2）：模板与源完全相同（逐字段比较一致）。
  - `oma-env-bench-commit-pool-tg`（replicas 2，附加）：只改 `terminationGracePeriodSeconds: 2`。
  - `oma-env-bench-commit-pool-ic`（replicas 1）：只加 `update-with-image-cache: "true"`。
- **create 参数：**
  - `claim-timeout-seconds` 150，`wait-ready-timeout-seconds` 300；
  - lifecycle 为 `{onTimeout: 'pause', autoResume: false}`；
  - `timeoutMs` 30 min（构建 Sandbox 40 min），`reserve-paused-sandbox-duration` 30m；
  - metadata 带 `oma.dev/load-test`；
  - 换镜像时传 `e2b.agents.kruise.io/image: registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-env-bench@<digest>`，按 digest 引用。
- **构建：**
  - S1/S2 初始化脚本与上一份报告完全相同（`init.sh`，sha256 `86bfbbce…`），以 root 身份、cwd `/home/user` 运行。构建 Sandbox 的 create `envs` 为 `{BENCH_PLAIN: p1, BENCH_BUILD_ENV: b1}`。
  - 脚本结束后执行 `apt-get clean; rm -rf /var/lib/apt/lists/* /root/.cache /home/user/.cache/pip`，在 `/opt/bench`、`/tmp`、`/home/user` 写入同一个 UUID，用 `head -c 629145600 /dev/urandom` 写出 `big.bin` 并记录 sha256，再启动一个 `nohup` 睡眠进程。全程不执行 `sync`。
  - 读一次 `/proc/meminfo` 的 Dirty，随即用 kubectl 创建 Commit：`spec: {podName, containerName: sandbox, image: …:<tag>, ttl: 6h, timeoutSeconds: 1800, registryAuth: {secrets: [ali-shanghai]}}`。每 2 s 轮询一次 phase，到达终态后 kill 构建 Sandbox，并确认 CR 已删除。
- **镜像检查：**
  - 通过公网 `registry.cn-shanghai.aliyuncs.com` 的 v2 API 读取 manifest 和 config，与基础镜像逐层、逐字段比较。env 只输出变量名。
  - S1 新层以流的方式下载并用 tarfile 列目录（只读名字和大小，不解压），用时 59 s。
- **换镜像样本：**
  - 等池子补货，然后领取。create `envs` 为 `{BENCH_PLAIN: p2}`。
  - 依次执行 firstCmd 和第二条命令，以 root 身份运行核对脚本（二进制、依赖、标记、big.bin sha、进程、uptime）。
  - 读取 PID 1 环境的变量名，检查 user、root、守护进程和按命令传入的 envs。
  - 读取 Pod `imageID`、事件和 manager 的 `ClaimMetrics`，kill 后确认 CR 已删除。
  - 令牌：SDK 的 `envdAccessToken` 和 CR 注解只以 sha256 形式存在本机权限 600 的文件里做相等比较，结束后删除。
- **顺序与并发：** 所有样本串行执行。同时存活的本次测试 Sandbox 最多 5 个（构建池 2 + 基础池 2 + 已领取 1），不超过 8 个。
- **Workspace 挂载：** 与上一份报告相同，用 oma-test Runner 的 bucket、PV 和 credential provider（`agentry` / `agentry-workspace-oss` / `agentry-oss-rw`），前缀为专用的 `env-commit-20261025/csi-swap-probe/`，不是真实租户。只做只读检查，没有写入。

## 没有验证的部分

- **ImageCache 与宽限期 2 s 叠加。** 预计约 5–6 s，没有实测。
- **不带 big.bin 的 S2。** 只按新层大小估算，约 10–13 s。
- **调短宽限期对正常删除的影响。** 例如 Workspace 写回、用户进程退出。另一种做法是让 `start-up.sh` 用 `exec` 或 `trap` 转发 SIGTERM，本次没有试。
- **并发换镜像和 ACR 带宽。** 多个会话同时拉取同一个或不同的新层时，耗时会怎样变化；ACS 2000 vCPU 配额与正式服共用。
- **集群内 Runner 链路。** 本机经 ALB 多出约 0.1–0.2 s，不影响结论。
- **ACR 侧的约束。** 独立命名空间、仓库数量配额、镜像保留和回收策略都没有验证。
- **构建 Sandbox 带 Workspace CSI 挂载时 Commit 的行为。** 推断挂载内容不会进镜像，因为运行时挂载点在新层里都是空目录。
- **root 能否从 envd 进程内存读出令牌。** 仍未验证。换镜像后令牌不共用，这个问题的影响面已经缩小到单个 Sandbox。

## 复现

驱动脚本只保存在本机 `/tmp/oma-env-commit/`，没有放进仓库：

- `lib.mjs`：公共函数；
- `build.mjs S1|S2|S1NB`：构建与 Commit；
- `swap.mjs <base|S1|S2|S1NB|S1IC> N [--set <池>] [--csi] [--image-from S1]`：领取与换镜像样本；
- `inspect-image.py`：registry v2 检查；
- `aggregate.py`：生成 JSON；
- `init.sh`：与上一份报告相同的初始化脚本，全文也保存在 JSON 的 `initScript` 字段。

逐样本数据、Commit CR、镜像 manifest/config 摘要、S1 新层的路径清单、ImageCache 状态和 ledger 见 [JSON 证据](environment-commit-bench-2026-10-25.json)。写出前已检查：不含 E2B key、registry 凭证和 envd 令牌（令牌只记录相等比较的布尔值）。

## 清理

- **过程：**
  1. 23 个 Sandbox 都通过 E2B `kill` 删除，每次 kill 后都用 kubectl 确认 CR 已消失。
  2. 3 个 Commit 用 kubectl 删除。
  3. 4 个 SandboxSet 先缩到 0，再删除。
  4. ImageCache `imc-uf6jfp9fd7g8ypkwne4p` 用 `aliyun acc delete-image-cache` 删除。
  5. ACR 仓库 `welltop/oma-env-bench` 连同 3 个 tag 一起删除。
  6. 本机的 E2B 凭证、registry 凭证和令牌哈希文件已删除。
- **核对结果（2026-10-25T07:37Z）：**

```text
$ kubectl --kubeconfig ~/.kube/agent-platform-config -n sandbox-system get sandboxset -l oma.dev/load-test=env-commit-20261025
No resources found in sandbox-system namespace.
$ ... get sandbox -l oma.dev/load-test=env-commit-20261025
No resources found in sandbox-system namespace.
$ ... get sandboxset --no-headers | grep -c oma-env-bench-commit
0
$ ... get sandbox --no-headers | grep -c oma-env-bench-commit
0
$ ... get commit --no-headers | wc -l
0
$ ... get sandboxtemplate --no-headers | grep -c oma-env-bench-commit
0
$ ... get pods --no-headers | grep -c oma-env-bench-commit
0
$ aliyun acc list-image-caches --biz-region-id cn-shanghai   # filter oma-env-bench-commit*
total caches: 4 bench caches remaining: 0
$ aliyun cr GET /repos/welltop/oma-env-bench --version 2016-06-07 --force
"code":"REPO_NOT_EXIST"
$ aliyun oss ls oss://agentry/env-commit-20261025/ --region cn-shanghai
Object Number is: 0
$ ... get sandboxset
auto-story-v2             8     8     8     8     f9bfdfdfb    41d
oma-scale-test-20261021   0     0                 6c789cb6fb   4d3h
oma-scale-test-20261022   0     0                 6d889fd9c5   3d13h
```

- **核对说明：** `auto-story-v2` 的 replicas 仍为 8（8/8 可用），generation 仍为 20，与开始时相同。`welltop/oma-sandbox` 仓库状态为 NORMAL，没有改动。
