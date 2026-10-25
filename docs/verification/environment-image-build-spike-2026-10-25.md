# Environment 镜像构建 Spike：ACS Pod 内用 buildah 构建推送，预热池原地换镜像

2026-10-25 23:29 – 10-26 00:30（Asia/Shanghai）在共享的 ACS 集群（agent-platform）上验证 [ADR-0024](../adr/0024-environments.md) 的镜像构建路径（#299）：在 `oma-test` 的 ACS general-purpose Pod 里用 buildah 按 ADR 的生成式 Dockerfile 构建 Environment 镜像，推到临时仓库 `welltop/oma-env-bench`；再在 `sandbox-system` 建一个临时预热池，验证领取时原地换镜像。基础镜像用线上 `auto-story-v2` 的镜像 digest 代替 `oma-media`，在它上面加 tini 作为 PID 1（下称 base-tini）。

**结论：路径可行。**

1. **构建：** buildah 在不带 `SYS_ADMIN`、没有 `/dev/fuse` 的 ACS Pod 里可以构建和推送，存储驱动只能用原生 overlay。
   - 镜像自带的配置会走 fuse-overlayfs，因为没有 `/dev/fuse` 而失败；vfs 拉基础镜像时把 60 GiB 临时盘写满（51.9 GB）后失败。
   - 去掉 `mount_program` 后，原生 overlay 在 user namespace 里挂载（带 `userxattr`），构建和推送都正常。
   - `video-production` 草稿脚本的镜像构建用 29.8 s。从 Pod 创建到推送完成约 2.3 min，其中拉基础镜像 65 s。
   - apt postinst、`chown -R user:user /home/user` 都正常，镜像配置和历史里没有凭证，也没有构建变量的值。
2. **换镜像：** 领取时把 `e2b.agents.kruise.io/image` 换成新镜像可以原地完成，envd、bash 和 Workspace CSI 挂载都正常，脚本装的工具都在。buildah 推出的单个 OCI manifest 和 OCI index 都能用。
3. **同镜像领取：** 传入与池子相同的镜像时容器不重启：restartCount 为 0，没有 Killing/Pulling 事件，WaitReady 21–29 ms，create 0.18–0.21 s。所以 Host 可以始终传入镜像，不需要跳过。
4. **tini：** 入口换成 tini 后，旧容器在 Killing 的同一秒以 143（SIGTERM）退出，不再等 30 s 宽限期。
   - 换镜像 create 用 3.6–5.2 s（池中 Pod 已就绪 ≥45 s 时，n=7，中位数 4.0 s）；Pod 刚就绪就被领取时为 4.2–6.8 s。
   - 上一份报告中同等新层大小的数据：宽限期 30 s 时为 34.3–36.1 s，宽限期 2 s 时为 6.3–7.5 s。

**与 ADR-0024 不符或需要修正的地方：**

- **GitHub 不能直连。** ACS Pod 直连 GitHub release 不可用：探测 4 次全部失败，第一次构建也因此失败。必须经 `sing-box` 代理，或者把产物放到镜像源。ADR 里“ACS pods reach github.com … without a proxy”对 GitHub 不成立。
- **基础镜像里的代理 ENV 会压过构建时的设置。** 当前镜像在配置里写死了 `HTTP(S)_PROXY` 和一个不含阿里云域名的 `NO_PROXY`。buildah 的 `--http-proxy` 透传和 `--build-arg` 都改不了这两个值，只有在 RUN 里 source 环境文件才能生效。
- **`chown -R` 让镜像层变大。** 它会把整棵 `/home/user` 复制进新层，本次新层里有 23 MB 是基础镜像遗留的 root 属主 npm 缓存。
- **`ARG` 会泄露变量值。** 变量值会写进 history，所以构建变量不能用 ARG 传。
- **预热池补货变慢。** 池子换成新镜像后不命中现有 ImageCache，每个 Pod 都要完整拉取 1.9 GB，用 73–81 s。

本次只创建并删除了自己的临时资源：

- `oma-test`：前缀为 `oma-env-spike-` 的构建 Pod 和 ConfigMap，标签 `oma.dev/test-only: "true"`；
- `sandbox-system`：SandboxSet `oma-env-spike-pool` 及其 Sandbox；
- ACR：临时仓库 `welltop/oma-env-bench`。

没有改动 `auto-story-v2`、`sing-box`、gateway/manager 或任何已有资源。清理核对见最后一节。

## 要点

1. **存储驱动：只有原生 overlay 可用。** 构建 Pod 的 CapEff 为 `a80425fb`（Docker 默认能力集，没有 `SYS_ADMIN`），没有 `/dev/fuse`，内核 `5.10.134-013.15.2.kangaroo.al8`，运行时是 Kata。直接 `mount` 和 `unshare -m` 都返回 EPERM。但 `unshare -U -r -m` 进入 user namespace 后，tmpfs、原生 overlay 和带 `userxattr` 的 overlay 都能挂载。逐项结果：

   | buildah 镜像 | 存储配置 | 结果 |
   |---|---|---|
   | `quay.io/buildah/stable:v1.43.5` | 镜像默认：overlay + `mount_program=/usr/bin/fuse-overlayfs` | 能拉取；`buildah run` 失败：`fuse: device /dev/fuse not found` |
   | 同上 | `--storage-driver vfs` | 小镜像能运行；拉 4.38 GB 的基础镜像，403.9 s 后 `no space left on device`，graphroot 写到 51.86 GB。vfs 把 65 层中的每一层都存成完整副本 |
   | 同上 | overlay，去掉 `mount_program`（原生，rootless） | **可用**：拉取、构建、推送都正常。`buildah info` 显示 `rootless: true`，`Native Overlay Diff: true` |
   | ACS 文档镜像 `ack-demo/buildah:v1.40.1` | 镜像默认（overlay，本来就没有 `mount_program`） | 可用，挂载参数带 `userxattr` |

   - 隔离方式是 chroot（镜像默认 `BUILDAH_ISOLATION=chroot`）。RUN 里的进程是真正的 root，`uid_map` 为 `0 0 4294967295`，没有进 user namespace，所以 chown、apt postinst 和普通 root 一样。
   - `RUN --mount=type=bind` 可用。
   - `buildah unshare` 这条命令本身在两个版本上都失败（`memfd_create(): Invalid argument`），但构建不依赖它。
   - 没有试 `/dev/fuse` hostPath，因为原生 overlay 已经可用。
2. **构建耗时与磁盘（4C8G，60 GiB 临时盘，原生 overlay）：**
   - Pod 从创建到 Running 37–38 s（第一次拉 buildah 镜像 18.1 s；第二次镜像已在节点上）。
   - 拉基础镜像（1.87 GB 压缩）67.1 s / 65.1 s，graphroot 为 4.38 GB。
   - 构建 base-tini 18.0 s，推送 4.8 s。
   - 构建 env-video 29.8 s（init.sh 26.4 s），推送 5.5 s，另推一个 index 3.0 s。每次构建 graphroot 增加约 52 MB。
   - **从 Pod 创建到推送完成约 138 s。** 拉基础镜像占一半。推送只上传新层：基础层在 ACR 里以 cross-repo mount 复用。
3. **apt postinst 和 chown 正常，但 `chown -R` 会复制整棵 `/home/user`。**
   - 安装 `vim-tiny file` 时执行了 postinst（`update-alternatives: using /usr/bin/vim.tiny to provide /usr/bin/editor`），libc-bin trigger 也跑了，`dpkg --audit` 没有报错。`jq` 从 deb12u1 升到了 deb12u3。
   - `chown -R` 之后，`/home/user`、`.cache`、`.local` 都变成 `user:user`；基础镜像里这几个目录原本是 root 属主。
   - 代价是 overlay 对每个被 chown 的文件都要 copy-up，属主没变的 `.bashrc`、`.profile` 也一样。结果新层 51.8 MB（未压缩）里有 23.4 MB 是基础镜像遗留的 `/home/user/.cache/npm/_cacache`（737 个文件，root 属主）。
   - 另外，manifest 步骤在 chown 之后以 root 运行 `npm ls -g`，在 `/home/user/.cache/npm/_logs/` 留下一个 root 属主的日志。Sandbox 里因此仍有 1–4 个不属于 user 的文件；逐一列出的那次只有这一个。
4. **镜像配置与历史里没有凭证，也没有构建变量的值。**
   - 推送凭证以文件挂载（`REGISTRY_AUTH_FILE=/run/oma-auth/auth.json`，来自 Secret `ali-shanghai`）。在 config、manifest 和 index 里搜索 `oma-auth`、`auth.json`、`REGISTRY_AUTH`、`password`、`Basic `、`dockerconfig`，都没有命中。
   - 构建变量通过 bind mount 的环境文件传入。`OMA_SPIKE_BUILD_PLAIN` 的值和变量名都不在 config 或 history 里。脚本能看到它，只把它的 sha256 写到了 `/opt/oma/spike-build-plain.sha256`。
   - history 里有 RUN 的原文，包括 `/tmp/oma-build.env` 这样的路径；buildah 还会在末尾追加 bind mount 源内容的 digest（`…:sha256:c99179…:sha256:bfa8da…`）。
   - 对照：`ARG` 加 `--build-arg` 时，history 记录为 `|1 OMA_SPIKE_ARG_PROBE=arg-probe-value-20261025 /bin/sh -c …`，值被持久化了。
   - 代理类的预定义参数（`--build-arg NO_PROXY=…`）不会进 history。
5. **镜像格式与原地换镜像。** `buildah push` 默认推单个 OCI image manifest（`application/vnd.oci.image.manifest.v1+json`），不是 index。`buildah manifest push --all` 推出的是 OCI index（一个 amd64 manifest）。两种都能用于原地换镜像，Pod 的 `imageID` 就是传入的 digest（index 时为 index 的 digest）。env-video 的 67 层里，前 66 层与 base-tini 逐层相同，新增 1 层，压缩后 32.3 MB。
6. **同镜像领取不会重启容器（n=3，另加 1 次冒烟）。**
   - restartCount 均为 0，容器 `startedAt` 都早于领取时间，PID 1（tini）的运行时长等于 Pod 年龄，领取后没有 Killing/Pulling 事件。
   - 网关：WaitReady 21–29 ms，InitRuntime 12–35 ms，create 182–208 ms。
   - 有一次 create 为 1,596 ms：领取的 Pod 2 s 前才就绪，InitRuntime 用了 1,414 ms。
   - **所以 Host 可以始终传 `e2b.agents.kruise.io/image`，不必跳过相同的镜像。**
7. **tini 让换镜像不再等宽限期（池子 `terminationGracePeriodSeconds` 仍为 30）。**
   - 10 次换镜像的旧容器全部在 Killing 的同一秒以 **143** 退出；上一份报告里是 30 s 后以 137 退出。
   - 时间分解：领取 → Killing 0.7–1.8 s → 旧容器退出 0 s → 新容器启动 2 s（包括拉取 32 MB 新层）→ create 返回 0.7–1.2 s（带 CSI 时 2.5 s）。
   - Pod 刚就绪就被领取的 3 次中，领取 → Killing 为 1.2–3.8 s。
8. **换镜像后的 Sandbox 正确（10 个）：**
   - 工具：vfs-cli v0.3.21、mediakit-cli 0.2.1、jq（dpkg 1.6-2.1+deb12u3）、file 5.44、ffmpeg 9.0.1、tini 0.19.0、node v22.23.2、google-genai 2.22.0、tomli-w 1.2.0，`editor → vim.tiny`。
   - 用户与目录：user 命令和默认命令都是 `whoami=user`、`HOME=/home/user`，root 命令是 `HOME=/root`；`/home/user` 可写。
   - `/opt/oma/manifest.json` 存在：dpkg 326 个、pip 185 个、npm 0 个、二进制 7 个。
   - 构建变量不在命令环境和 PID 1 环境里；PID 1 环境里没有 base-secret 的变量名。
   - 14 次领取的 envd 令牌两两不同（只比较 sha256 前缀）。
   - Workspace CSI 挂载：`/home/user/workspace → /run/csi/mount-root/oss/<hash>`，类型 fuseblk，CSIMount 1,411 ms。
9. **profile 写法决定按命令注入能否覆盖。**
   - `export OMA_SPIKE="${OMA_SPIKE:-from-profile}"`：按命令注入 `injected` 时得到 `injected`，不注入时为 `from-profile`。
   - 直接 `export OMA_SPIKE_HARD="from-profile-hard"`：注入后仍是 `from-profile-hard`。
   - 这与 ADR 的规则一致：脚本要想让变量可以被覆盖，必须用 `${:-}` 写法。
   - create `envs`（`OMA_SPIKE_CREATE_ENV=create-1`）在换镜像后的命令里可见。
10. **池子补货不命中 ImageCache。**
    - 13 个池 Pod 都完整拉取 base-tini（1.88 GB），用 73.0–81.0 s，`matched-image-caches` 为空。池子从创建到 2/2 可用约 1 min 51 s。
    - 对照：`auto-story-v2` 的 Pod 命中 `imc-uf6c2ys46pzt3c3grd74`。
    - 推断：池子镜像换成 `video-production` 的新 digest 后，补货都会这么慢，除非为池子镜像建 ImageCache。
11. **GitHub 不能直连，必须走代理。** 详见“代理”一节。

## 结果

### 构建（原生 overlay，quay buildah v1.43.5，4C8G / 60 GiB）

| 步骤 | 耗时 | graphroot / 盘使用 | 说明 |
|---|---:|---|---|
| 构建 Pod 创建 → Running | 37 s / 38 s | — | 第一次拉 buildah 镜像 18.1 s；第二次镜像已在节点上 |
| 拉 `oma-sandbox@sha256:67a46af6…`（1.87 GB 压缩） | 67.1 s | 4.38 GB / 8.08 GB | `df` 的 8.08 GB 包括 Pod 自身根文件系统约 3.1 GB |
| 同上，vfs | 403.9 s 后失败 | 51.86 GB / 60.8 GB | ENOSPC |
| 构建 base-tini（apt 装 tini，改 ENTRYPOINT/CMD） | 18.0 s | +2.5 MB | |
| 推送 base-tini | 4.8 s | | 新层 766,967 B；基础层 cross-repo mount |
| 新 Pod 冷拉 base-tini@digest | 65.1 s | 4.39 GB | |
| 构建 env-video（第一次，GitHub 直连） | 380.6 s 后失败 | | vfs-cli 下载约 290 s，mediakit-cli `curl: (18) HTTP/2 stream … not closed cleanly` |
| **构建 env-video**（GitHub 经代理，apt/pip 直连） | **29.8 s** | +52 MB | init.sh 26.4 s：vfs-cli 2.71 s、mediakit-cli 2.52 s、pip 2.69 s、apt 18.46 s |
| 推送 env-video | 5.5 s | | 新层 32,297,442 B |
| 推送 env-video 的 OCI index | 3.0 s | | |
| 附加：env-video，代理走 `--http-proxy` 透传（未推送） | 32.4 s | | 见“代理” |
| 附加：env-video，代理写在环境文件里（未推送） | 26.9 s | | 见“代理” |
| ARG 探针（未推送） | 0.6 s | | 见要点 4 |

- **冷构建合计：** Pod 38 s + 拉基础镜像 65.1 s + 构建 29.8 s + 推送 5.5 s ≈ **138 s**。
- **构建时长的大头：** 主要取决于拉基础镜像，与脚本关系不大。
- **CPU 与内存：** 没有在负载下测；空闲时 `kubectl top` 为 0m / 319 Mi。
- **apt 的 18.46 s：** 包括第一次 `apt-get update` 下载完整的 Packages 列表，以及直连基础镜像 apt 源里的 `deb.nodesource.com`。走代理的两个变体里，apt 安装只用 3.4–3.7 s，因为 lists 已由诊断步骤更新过，不能直接比较。

### 镜像

| | base-tini | env-video |
|---|---|---|
| digest | `sha256:aaec4b2d…5471` | `sha256:718bc931…8079`；index `sha256:042382dc…a777` |
| mediaType | OCI image manifest | OCI image manifest；index 为 OCI image index，含 1 个 amd64 manifest |
| 层数 | 66 = 基础镜像 65 层 + 1 层 | 67 = base-tini 66 层（逐层相同）+ 1 层 |
| 新层 | 766,967 B | 32,297,442 B（未压缩 51.8 MB，950 个条目） |
| 总大小（各层 + config） | 1,875,669,065 B | 1,907,967,983 B |
| Entrypoint / Cmd | `["/usr/bin/tini","-g","--"]` / `["bash","/root/.jupyter/start-up.sh"]` | 同左 |
| Env | 与基础镜像相同（32 个变量） | 与 base-tini 相同 |
| User / WorkingDir | root / /root | 同左 |
| 新增 history | 5 条（USER、RUN、ENTRYPOINT、CMD、LABEL；只有 LABEL 一条带层） | 3 条（RUN、RUN、LABEL；只有 LABEL 一条带层） |
| 新增 Labels | `dev.oma.spike`、`dev.oma.base-of`、`io.buildah.version=1.43.5` | `dev.oma.environment`、`dev.oma.build` |

buildah 默认 `--layers=false`，一个 Dockerfile 只产生一层，记在最后一条指令上。

**env-video 新层内容（按目录，未压缩）：**

| 路径 | 条目 | 大小 | 来源 |
|---|---:|---:|---|
| `home/user/.cache`（`npm/_cacache` 737 个） | 744 | 23.4 MB | `chown -R` copy-up 了基础镜像遗留的 root 属主 npm 缓存 |
| `usr/local/bin` | 3 | 15.95 MB | vfs-cli 8.72 MB、mediakit-cli 7.23 MB |
| `usr/lib/file`、`usr/bin/vim.tiny` 等 | — | 约 10.5 MB | apt 安装 |
| `var/lib/dpkg`、`var/cache/debconf`、`var/log` | — | 约 1.7 MB | dpkg 状态和日志 |
| `opt/oma` | 3 | 14 KB | `manifest.json`、`spike-build-plain.sha256` |
| `etc/profile.d/oma-spike.sh` | 1 | 88 B | |
| whiteout | — | — | `root/.wh..cache`、`tmp/.wh.tmppaig0n_z_kernels`（`rm -rf /root/.cache /tmp/*` 删除了基础镜像里的内容） |

新层里没有 `/run`、`/tmp/oma-init.sh`、`/tmp/oma-build.env`、`/run/oma-auth` 或任何凭证文件。线上镜像本身已经带 vfs-cli v0.3.21 和 mediakit-cli 0.2.1，所以本次的 8.7 MB + 7.2 MB 是重复安装。正式的 `oma-media` 不带这两个工具，ADR 规定由脚本安装。

### 领取：同镜像与换镜像（runner Pod 内 SDK 计时，毫秒；p50 / min / max）

| 路径 | n | create | firstCmd | 网关 WaitReady | restartCount | 旧容器退出 |
|---|---:|---|---|---|---|---|
| 同镜像（base-tini） | 3 | **204** / 182 / 1,596 | 40 / 38 / 111 | 24 / 21 / 24 | 0 | 不重启 |
| 同镜像冒烟 | 1 | 208（墙钟时间） | — | 29 | 0 | 不重启 |
| 换成 env-video，Pod 刚就绪 | 3 | 5,854 / 4,160 / 6,849 | 108 / 46 / 123 | 5,469 / 3,990 / 6,534 | 1 | 143 |
| 换成 env-video，Pod 就绪 ≥45 s | 3 | **4,341** / 3,908 / 4,901 | 48 / 39 / 80 | 4,033 / 3,541 / 4,593 | 1 | 143 |
| 换成 env-video 的 OCI index，就绪 ≥45 s | 2 | 3,800 / 3,632 / 3,968 | 42 / 40 / 45 | 3,425 / 3,188 / 3,662 | 1 | 143 |
| 换成 env-video + Workspace CSI，就绪 ≥45 s | 1 | 5,180 | 37 | 3,337（CSIMount 1,411） | 1 | 143 |
| 换成 env-video（附加，列出非 user 属主文件） | 1 | 4,031 | 117 | 3,657 | 1 | 143 |
| *上一份报告：S1NB（37.5 MiB 新层），宽限期 30 s* | 2 | 35,192 / 34,308 / 36,077 | 231 | 34,998 | 1 | 137（30 s） |
| *上一份报告：S1NB，宽限期 2 s* | 3 | 6,537 / 6,276 / 7,509 | 292 | 6,234 | 1 | 137（2 s） |
| *上一份报告：预热领取，不换镜像* | 2 | 160 / 114 / 207 | 158 | 0 | 0 | — |

- **样本挑选：** 池子 Pod 就绪 ≥45 s 后才领取的 7 次（含 index 和 CSI）：create 3,632–5,180 ms，中位数 4,031 ms。“Pod 刚就绪”这一组是驱动等到 2/2 可用后立刻领取的结果，领到的 Pod 刚就绪 0–2 s。此后改为等最年轻的 Pod 就绪满 45 s 再领取。
- **网关侧耗时：** 换镜像的时间几乎都在 WaitReady；PickAndLock 8–12 ms，InitRuntime 17–291 ms。

### 换镜像的时间分解（秒，k8s 事件与容器状态精度 1 s）

| 路径 | 领取 → Killing | Killing → 旧容器退出 | 退出 → 新容器启动（包括拉取新层） | 启动 → create 返回 | create |
|---|---|---|---|---|---|
| env-video，Pod 刚就绪 | 1.2–3.8 | 0（143） | 2 | 1.0–1.2 | 4.2–6.8 |
| env-video，就绪 ≥45 s | 0.7–1.8 | 0（143） | 2 | 0.9–1.2 | 3.9–4.9 |
| index，就绪 ≥45 s | 0.9–1.0 | 0（143） | 2 | 0.7–0.9 | 3.6–4.0 |
| CSI，就绪 ≥45 s | 0.7 | 0（143） | 2 | 2.5 | 5.2 |
| *上一份报告：S1NB，宽限期 30 s* | 1.2–1.5 | 30（137） | 2 + 0–2 | 约 1–2 | 34.3–36.1 |
| *上一份报告：S1NB，宽限期 2 s* | 1.0–1.4 | 2（137） | 2 + 0–1 | 约 1–2 | 6.3–7.5 |

近似公式：create ≈ 1 s + 新层拉取与启动 2 s + 1 s，宽限期不再计入。上一份报告的公式是 1.5 s + 宽限期 + 2 s + 拉取 + 1–2 s。

### 换镜像后的 Sandbox（10 个）

| 检查项 | 结果 |
|---|---|
| 工具 | vfs-cli v0.3.21、mediakit-cli 0.2.1（二进制 sha256 `2c962efe…`，与 `versions.json` 的 binarySha256 一致）、jq-1.6（dpkg `1.6-2.1+deb12u3`）、file-5.44、ffmpeg 9.0.1、tini 0.19.0、node v22.23.2、rg 15.1.0 |
| Python | google-genai 2.22.0（基础镜像已有）、tomli-w 1.2.0（脚本安装） |
| postinst | `readlink -f /usr/bin/editor` = `/usr/bin/vim.tiny`；`dpkg --audit` 没有报错；`vim-tiny`、`file` 都是 `install ok installed` |
| 属主 | `/home/user`、`.cache`、`.cache/npm`、`.local`、`.oma-spike/marker` 都是 `user:user`。不属于 user 的文件 1–4 个；逐一列出的那次只有 `.cache/npm/_logs/…-debug-0.log`（root），是 manifest 步骤的 npm 写的 |
| 用户 | 默认命令和 `user: 'user'`：`whoami=user`、`HOME=/home/user`、`PWD=/home/user`；`user: 'root'`：`HOME=/root` |
| 构建清单 | `/opt/oma/manifest.json`：`binaries`（7 个）、`dpkg`（326 个）、`pip`（185 个）、`npm`（0 个，因为 `npm ls -g` 不包括 `/opt/oma-pi-tools`） |
| PID 1 | `/usr/bin/tini -g -- bash /root/.jupyter/start-up.sh`，进程组：tini(1) → bash(7) → jupyter-server；envd 由 postStart 启动，不在 tini 的进程组里 |
| 构建变量 | `OMA_SPIKE_BUILD_PLAIN` 不在命令环境里，也不在 `/proc/1/environ` 里；只有脚本主动写下的 sha256 文件 |
| PID 1 环境中的 base-secret 变量名 | 0 个（池子模板已去掉 base-secret） |
| envd 令牌 | 14 次领取两两不同（只比较 sha256 前 16 位） |
| Workspace CSI | `/home/user/workspace → /run/csi/mount-root/oss/230b9042…`，`stat -f` 为 fuseblk，vfs-cli 可用 |

### 环境变量语义（换镜像后）

| 变量 | 来源 / 写法 | 普通命令 | 按命令传入 `envs` 为 `injected` |
|---|---|---|---|
| `OMA_SPIKE` | `/etc/profile.d`：`export OMA_SPIKE="${OMA_SPIKE:-from-profile}"` | from-profile | **injected** |
| `OMA_SPIKE_HARD` | `/etc/profile.d`：`export OMA_SPIKE_HARD="from-profile-hard"` | from-profile-hard | from-profile-hard（注入被覆盖） |
| `OMA_SPIKE_CREATE_ENV` | create `envs` | create-1 | — |
| `OMA_SPIKE_BUILD_PLAIN` | 构建时的环境文件 | 未设置 | — |
| `HTTP_PROXY` | 镜像配置 ENV（只有 PID 1 能看到） | 未设置 | — |

## 代理

基础镜像（线上 `auto-story-v2`）在镜像配置里写死了以下变量；RUN 会继承镜像配置的 ENV：

```text
HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy = http://sing-box.oma-infra.svc.cluster.local:7890
NO_PROXY / no_proxy = localhost,127.0.0.1,::1,.svc,.cluster.local
```

构建 Pod 内 `sing-box.oma-infra.svc.cluster.local` 能解析到 10.0.165.246，RUN 里也能解析，不需要改用 IP。sing-box 只读使用，没有改动。

| 变体 | 代理怎么传 | 脚本看到的 `NO_PROXY` | GitHub（vfs-cli / mediakit-cli） | 阿里云 pip/apt 源 | 是否持久化 |
|---|---|---|---|---|---|
| 直连（第一次构建和探测） | RUN 里 `env -u` 清掉代理 | — | **不可用**：第一次构建中 vfs-cli 下载约 290 s，mediakit-cli `curl (18)`；4 次探测为 3 次 15 s 连接超时、1 次 90 s 后被重置 | 直连 | — |
| A（已推送，用于换镜像） | RUN 里 `env -u` 清掉镜像的代理；GitHub 下载显式 `--proxy`，代理地址来自环境文件的普通变量 | — | 2.71 s / 2.52 s（步骤耗时，含校验和安装） | 直连；apt 18.46 s，包括直连 `deb.nodesource.com` | 不在 config/history |
| B（未推送） | buildah `--http-proxy=true`，在 buildah 进程上设置维护者给的 `HTTP(S)_PROXY` 和 `NO_PROXY=localhost,127.0.0.1,.svc,.cluster.local,.aliyuncs.com,.aliyun.com,.npmmirror.com` | **基础镜像的值**（不含阿里云域名） | 经代理 2.62 s / 2.49 s（curl `via=10.0.165.246:7890`） | **也经代理**：curl `via=10.0.165.246:7890`；apt `CONNECT mirrors.aliyun.com:443` | 不在 config/history |
| B'（探针） | `--build-arg NO_PROXY=… --build-arg no_proxy=…` | 基础镜像的值 | — | — | 不在 history（buildah 把代理类当作预定义参数） |
| C（未推送） | 同一组变量写进 bind mount 的环境文件，在 RUN 里 `set -a; . file` | 构建给的值 | 经代理 2.34 s / 2.67 s（`via=10.0.165.246:7890`） | **直连**：pip 源 `via=180.97.214.184:443`，apt 源 `via=180.97.214.188:443`；apt 对阿里云直接 `GET`；只有 `deb.nodesource.com` 走 `CONNECT` 经代理 | config Env 与 base-tini 逐项相同；`.npmmirror.com` 不在 config/history |

- **核对方法：** 对 B、C 和 A 三个本地镜像执行 `buildah inspect --type image`：比较 OCI config 的 Env 与 base-tini 是否逐项相同，并在 OCIv1/Docker 两份 config 和 history 里搜索 `.npmmirror.com` 和 `plain-build-value`。
- **结论：**
  - 只要基础镜像带代理 ENV，透传和 `--build-arg` 就都改不了 `NO_PROXY`，阿里云源也会经 sing-box。
  - 想让代理和 `NO_PROXY` 生效，可以二选一：`oma-base` 不再写代理 ENV（推荐，这样 `--build-arg` 也能用）；或者把它们当作平台默认变量，写进 bind mount 的环境文件，在 RUN 里 source。
  - 两种做法都不会把值写进镜像。

## 对 ADR-0024 待定项的结论

1. **存储驱动、apt postinst 与 chown、构建时间与磁盘。**
   - **存储驱动用原生 overlay。** 去掉 `mount_program`，buildah 以 rootless 方式在 user namespace 里挂载，带 `userxattr`。vfs 不可行，这个基础镜像会写满 60 GiB。fuse-overlayfs 需要 `/dev/fuse`，不需要。
   - **quay buildah 镜像必须换掉默认的 `storage.conf`。** 它默认用 fuse-overlayfs；ACS 文档镜像 v1.40.1 默认就是原生 overlay。
   - **apt postinst 和 `chown` 正常。** RUN 以真正的 root 运行（chroot 隔离，不进 user namespace）。
   - **构建时间与磁盘：**
     - video-production 草稿：构建 29.8 s；从 Pod 创建到推送完成约 2.3 min，其中拉基础镜像 65 s。
     - 磁盘：基础镜像 4.4 GB，每次构建另加约 50 MB。
     - `oma-media` 本身（源码编译 FFmpeg）没有在 buildah Pod 里构建。按 ADR，Base Image 由平台手工构建；本次的替身 base-tini 构建 18 s、推送 4.8 s。
2. **同镜像领取不重启；容器响应 SIGTERM 后的换镜像耗时。**
   - **同镜像领取不重启**（restartCount 0，没有事件，WaitReady 21–29 ms）。Host 可以始终传 digest。
   - **换镜像不再等宽限期。** 入口换成 `tini -g --` 后，旧容器在 Killing 的同一秒以 143 退出。Pod 就绪 ≥45 s 时换镜像 3.6–5.2 s（中位数 4.0 s，32 MB 新层）；Pod 刚就绪时 4.2–6.8 s。`terminationGracePeriodSeconds` 不用调短。
3. **index 是否被原地换镜像接受。**
   - 接受。buildah 默认推的是单个 OCI manifest；用 `buildah manifest push --all` 推出的 OCI index 同样可用，Pod `imageID` 为 index 的 digest。
   - 两种格式都可以，推荐默认的单 manifest，省一层间接引用。

**ADR 需要补充或修正的地方：**

- **GitHub 不可直连。** 构建 Pod 访问 GitHub 必须经代理（sing-box），或者把下载产物放到阿里云/OSS 镜像源。ADR 的网络事实需要改成“GitHub 需经代理”。
- **`oma-base` 不要在镜像配置里写代理 ENV。** 当前镜像的 `HTTP(S)_PROXY`/`NO_PROXY` 会压过构建时的设置；运行时 PID 1 也会继承。构建所需的代理作为平台默认变量传给 RUN，见“代理”一节。
- **不能用 `ARG` 传 Environment 变量**，值会进 history。用 bind mount 的环境文件；history 里只留下路径和文件内容的 digest。推断：因为有 digest，密钥不能进这个文件，这与 ADR“脚本看不到密钥”一致。
- **生成式 Dockerfile 的第二个 RUN 需要调整：**
  - 先写 manifest，再 chown；或者 manifest 步骤用 `HOME=/root`，避免 npm 以 root 往 `/home/user` 写日志。
  - `chown -R` 会把整棵 `/home/user` 复制进新层。`oma-base` 应该保证 `/home/user` 全部归 user，并且不带缓存（本次的 23 MB npm 缓存）。改为只 chown 不属于 user 的文件（`find /home/user \( ! -user user -o ! -group user \) -exec chown -h user:user {} +`）。推断：这样只会复制被改动的文件，本次没有实测。
  - manifest 的 npm 部分应该列 `/opt/oma-pi-tools`。
- **池子补货需要 ImageCache。** 池子镜像（video-production 的 digest）不命中现有 ImageCache，每次补货完整拉取 1.9 GB，用 73–81 s。builder 更新池子镜像时，应同时为它建 ImageCache，或者接受这个补货时间。
- **入口改法已验证。** `ENTRYPOINT ["/usr/bin/tini","-g","--"]` 加 `CMD` 为原入口，其余行为不变：Jupyter、uvicorn、envd 都正常。tini 来自 Debian 包 `tini 0.19.0-1+b3`，增加 767 KB。

**推荐的构建 Pod 设置（本次实际使用）：**

- **计算类与资源：**
  - 标签 `alibabacloud.com/compute-class: general-purpose`、`alibabacloud.com/compute-qos: default`；
  - requests 等于 limits：4 CPU / 8 GiB / ephemeral-storage 60 GiB；
  - `restartPolicy: Never`，`automountServiceAccountToken: false`，不需要 privileged 或 `SYS_ADMIN`，也不需要 `/dev/fuse`。
  - 实测峰值：graphroot 4.5 GB，加 Pod 自身根文件系统约 3 GB；内存没有在负载下测。60 GiB 对重脚本留有余量。
- **镜像：** `quay.io/buildah/stable:v1.43.5@sha256:4cb71c73…`，镜像到 `welltop`。也可以用 ACS 文档镜像 v1.40.1（`sha256:32a7c27f…`）。
- **存储：**
  - `/var/lib/containers` 挂 emptyDir，落在 ext4；
  - 用 `CONTAINERS_STORAGE_CONF` 指向如下配置：

    ```toml
    [storage]
    driver = "overlay"
    runroot = "/run/containers/storage"
    graphroot = "/var/lib/containers/storage"
    [storage.options.overlay]
    mountopt = "nodev"
    ```

  - 不要 `mount_program`，不要 vfs。
- **构建命令：**
  - `buildah build --isolation chroot --pull=never -f Dockerfile -t … ctx`：先 `buildah pull docker://<base>@<digest>`，单独计时，便于区分基础设施失败；
  - `buildah push --digestfile … docker://registry-vpc.cn-shanghai.aliyuncs.com/welltop/<repo>:<tag>`。
- **凭证与代理：**
  - 推送凭证用 `REGISTRY_AUTH_FILE` 指向 Secret 挂载的文件。
  - 代理和 `NO_PROXY` 写进 bind mount 的环境文件，在 RUN 里 source；Pod 本身不设代理。
- **超时：** ADR 的 60 min 足够。本次正常的 Environment 构建约 2.3 min；GitHub 直连失败那一次卡了 6.3 min，脚本里的下载需要 `--retry-all-errors` 和 `--max-time`。

## 异常与失败

1. **第一次构建 env-video 失败（rc=18，380.6 s）。** GitHub 直连：vfs-cli 下载约 290 s 才完成，随后 mediakit-cli 报 `curl: (18) HTTP/2 stream 1 was not closed cleanly`。`--retry 3` 默认不重试 (18)。改为 GitHub 经代理并加 `--retry-all-errors` 后成功。
2. **vfs 写满临时盘。** 见要点 1。vfs 对比 Pod 只拉取了基础镜像，没能构建，已删除。
3. **ACS 文档镜像（v1.40.1）只做了小镜像验证。** 正式构建用的是 quay v1.43.5 加自定义 `storage.conf`。
4. **`buildah unshare` 失败（`memfd_create(): Invalid argument`）。** 两个版本都失败，并且会递归重入；不影响 `pull`、`build`、`run`、`push`。
5. **驱动计时错误。** 同镜像冒烟样本的 `createMs` 为 0：对象字面量在 `await` 之前就算出了 `ms`。已修正。该样本改用墙钟时间 createStartedAt → createEndedAt，为 208 ms，在 JSON 里标为 `same-smoke`。
6. **构建脚本有临时改动。** env-video 第一次构建前把 apt 包从只装 `jq` 改为 `jq vim-tiny file`：基础镜像已有 `jq`，装它测不到 postinst。pip 加了 `tomli-w==1.2.0`：基础镜像已有 `google-genai==2.22.0`。
7. **代理变体是后来追加的。** 按维护者在运行中追加的要求，加测了代理变体 B 和 C。换镜像用的是变体 A 的镜像。B、C 与 A 的脚本只差代理诊断和下载计时，没有推送。
8. **没有其他失败。** 14 次 E2B create 全部成功，所有 kill 后 CR 都已消失。

## 方法

- **集群与凭证：**
  - 集群为 agent-platform，`kubectl --kubeconfig ~/.kube/agent-platform-config`。
  - E2B 调用全部在 `oma-test/oma-runner-768cfdffc9-gn8j2` 里用该 Pod 的 `E2B_API_KEY`/`E2B_DOMAIN` 执行，e2b SDK 2.24.0，用 `createRequire('/app/server/packages/sandbox/package.json')` 加载。key 和 envd 令牌都没有离开 runner Pod，只回传 sha256 前 16 位。
  - 本机读取 registry 时，把 `oma-test/ali-shanghai` 解码写成权限 600 的临时 docker config，只给 `crane manifest/config/blob` 用，结束后删除。
- **基础镜像：** `auto-story-v2`（resourceVersion 66031925，generation 20）的镜像为 `welltop/oma-sandbox@sha256:67a46af6…`（OCI index，amd64 manifest `0f82d36a…`，65 层）。
  - Entrypoint `bash /root/.jupyter/start-up.sh`，Cmd 为空，User root，WorkingDir /root。
  - `start-up.sh` 把 `start_jupyter_server &` 放到后台，前台运行 `jupyter server`，没有 trap。
  - envd 由 postStart `bash /mnt/envd/envd-run.sh` 启动。
- **构建 Pod：** `oma-test/oma-env-spike-build-{1,2,3,4}`。
  - 共同配置：标签 `compute-class: general-purpose`、`compute-qos: default`、`oma.dev/test-only: "true"`；4C8G / 60 GiB；`restartPolicy: Never`；`activeDeadlineSeconds: 14400`。
  - 挂载：Secret `ali-shanghai`（`items: .dockerconfigjson → auth.json`，`defaultMode 0400`）、ConfigMap `oma-env-spike-ctx`（构建上下文），`/var/lib/containers` 挂 emptyDir；没有代理 env。
  - 各 Pod 用途：
    - 1：quay v1.43.5，测存储驱动，构建并推送 base-tini；
    - 2：ACS v1.40.1，只做小镜像验证；
    - 3：quay，vfs 对比；
    - 4：quay，冷构建 env-video 和代理变体。
  - 每一步都在 Pod 内以纳秒时间戳计时，并记录 `du -sb graphroot` 和 `df`。
- **生成式 Dockerfile：** 与 ADR 的形状相同，只多了一个 bind mount 的环境文件。

  ```dockerfile
  FROM registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-env-bench@sha256:aaec4b2d…
  RUN --mount=type=bind,source=init.sh,target=/tmp/oma-init.sh \
      --mount=type=bind,source=build.env,target=/tmp/oma-build.env \
      cd /home/user && set -a && . /tmp/oma-build.env && set +a && \
      env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy bash -euo pipefail /tmp/oma-init.sh
  RUN --mount=type=bind,source=write-manifest.sh,target=/run/oma-write-manifest \
      chown -R user:user /home/user && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* \
      && mkdir -p /opt/oma && bash /run/oma-write-manifest > /opt/oma/manifest.json
  LABEL dev.oma.environment=env_spike_video_production dev.oma.build=bld_spike_20261025
  ```

- **init.sh（video-production 草稿）：**
  - 记录构建变量的 sha256；
  - GitHub 下载 vfs-cli v0.3.21：`vfs-cli_v0.3.21_linux_amd64.tar.gz`，实测 sha256 `13a8125d6083d4747fe74b6d74142121c8c272c10f77b23e5b22334ab48abacb`，与 release 资产的 digest 和线上镜像 history 中记录的一致；
  - mediakit-cli 0.2.1：sha256 `8c25ebd7…`，与 `versions.json` 一致；两者都先校验 sha256，再 `install` 到 `/usr/local/bin`；
  - `pip install google-genai==2.22.0 tomli-w==1.2.0`；
  - `apt-get install jq vim-tiny file`；
  - 写 `/etc/profile.d/oma-spike.sh`；
  - 在 `/home/user` 下以 root 写一个标记文件。

  全文和 `write-manifest.sh` 都在 JSON 的 `scripts` 字段里。
- **池子：** `sandbox-system/oma-env-spike-pool`，从 `auto-story-v2` 复制，去掉 status/uid/resourceVersion/updateStrategy。
  - 删除 18 个 base-secret secretKeyRef env；线上模板本来就没有 `source.env` 卷，保留了 `vfs-cli-policy` ConfigMap 卷。
  - 镜像为 base-tini@digest，replicas 2，`terminationGracePeriodSeconds: 30`，保留 `enable-image-cache` 注解；SandboxSet 和模板都加 `oma.dev/test-only: "true"`。
- **领取：**
  - 本机 `swap.py` 串行执行：等池子 2/2 可用（后几组还要求最年轻的 Pod 就绪满 45 s）→ 在 runner Pod 里 create → 本机读 Pod 状态、Sandbox CR、事件和 manager 的 ClaimMetrics → 在 runner Pod 里 kill → 确认 CR 消失。
  - create 参数：metadata `oma.dev/test-only: env-spike-20261025`，`claim-timeout-seconds` 150，`wait-ready-timeout-seconds` 300，`reserve-paused-sandbox-duration` 30m；换镜像时加 `e2b.agents.kruise.io/image: …@<digest>`；create `envs` 为 `{OMA_SPIKE_CREATE_ENV: create-1}`；lifecycle `{onTimeout: pause, autoResume: false}`。
  - CSI 样本使用 runner 的 `WORKSPACE_OSS_*` 资源名，前缀为 `env-spike-20261025/csi-swap-probe/`，只读，不写。
  - 同时存活的本次 Sandbox 最多 3 个（池 2 个加已领取 1 个）。
- **镜像检查：** 用 `crane manifest/config`（经公网 `registry.cn-shanghai.aliyuncs.com`）与基础镜像逐层、逐字段比较。env-video 的新层用 `crane blob | tar -t` 只列名字和大小。

## 没有验证的部分

- **`oma-media` 的源码构建：** FFmpeg 编译、Pi 运行时安装在 buildah Pod 里要多久，没有测。
- **重脚本：** 例如上一份报告的 S2（约 1 GB 新层、4–8 min 脚本）在 buildah 下的构建时间、内存和磁盘峰值，以及换镜像时更大新层的拉取时间。按上一份报告约 45–80 MB/s 推算，1 GB 约 13–23 s，没有实测。
- **只 chown 非 user 文件能否避免整树 copy-up：** 见上文的推断。
- **为池子镜像建 ImageCache 后的补货时间**，以及 `update-with-image-cache` 对换镜像的影响。上一份报告发现带该注解的池子扩容不命中基础镜像缓存。
- **并发：** 多个构建 Pod 并发，以及多个会话同时换镜像时的 ACR 带宽。
- **sing-box 的负载与可用性：** 它是正式服共用的代理，构建流量（尤其是不配 `NO_PROXY` 时的 apt/pip）会增加它的负载。
- **`RUN --mount=type=secret` 的行为。** ADR 不把密钥交给脚本，所以没有测。
- **kaniko（Chainguard fork）对照。** buildah 可行，按 issue 的验收标准不需要。

## 复现

驱动和中间文件只保存在本机 `/tmp/oma-env-spike/`，没有放进仓库：

- `build-pod.tmpl.yaml`：构建 Pod 模板；
- `build-run.sh`：Pod 内构建驱动，计时并记录磁盘；
- `ctx/`：`Dockerfile.*`、`init.sh`、`init-proxy.sh`、`write-manifest.sh`、`storage-native.conf`、`storage-vfs.conf`、`build*.env`；
- `sandboxset-pool.json`：池子清单；
- `e2b-spike.mjs`、`check-user.sh`、`check-root.sh`：runner Pod 内的 E2B 驱动；
- `swap.py`：本机编排，负责 kubectl 侧的观测；
- `aggregate.py`：生成 JSON。

逐样本数据、构建计时、镜像 manifest/config 摘要、新层清单摘要、代理诊断、全部脚本和清理记录见 [JSON 证据](environment-image-build-spike-2026-10-25.json)。写出前已检查：不含 E2B key、registry 凭证和 envd 令牌（令牌只保留 sha256 前缀）。

## 清理

- **过程：**
  1. 14 个 Sandbox 都在 runner Pod 里用 E2B `kill` 删除，每次之后都确认 CR 已消失。结束时用 `Sandbox.list`（metadata `oma.dev/test-only=env-spike-20261025`）复查，结果为 0 个。
  2. SandboxSet `oma-env-spike-pool` 先缩到 0，等 Pod 全部消失后删除。
  3. 构建 Pod 1–4 和 ConfigMap `oma-env-spike-ctx` 都已删除。
  4. 两个 runner Pod 里的 `/tmp/oma-env-spike-*` 临时脚本已删除。
  5. ACR 仓库 `welltop/oma-env-bench`（3 个 tag：`base-tini-20261025`、`env-video-20261025`、`env-video-index-20261025`）用 `aliyun cr DELETE /repos/welltop/oma-env-bench --version 2016-06-07 --force` 删除。
  6. 本机的临时 registry 凭证目录已删除。
- **核对结果（2026-10-25T16:29Z）：**

```text
$ kubectl --kubeconfig ~/.kube/agent-platform-config -n sandbox-system get sandboxset
auto-story-v2             8     8     8     8     f9bfdfdfb    41d
oma-scale-test-20261021   0     0                 6c789cb6fb   4d11h
oma-scale-test-20261022   0     0                 6d889fd9c5   3d22h
$ ... -n sandbox-system get sandboxset,sandbox,pods --no-headers | grep -c oma-env-spike
0
$ ... -n sandbox-system get sandboxset,sandbox,pods -l oma.dev/test-only=true
sandboxset.agents.kruise.io/oma-scale-test-20261022   0   0   6d889fd9c5   3d22h   # 已有资源，不是本次创建
$ ... -n oma-test get pods,configmaps --no-headers | grep -c oma-env-spike
0
$ ... -n oma-test get pods,configmaps -l oma.dev/test-only=true
No resources found in oma-test namespace.
$ aliyun cr GET /repos/welltop/oma-env-bench --version 2016-06-07 --force
"code":"REPO_NOT_EXIST"
$ aliyun oss ls oss://agentry/env-spike-20261025/ --region cn-shanghai
Object Number is: 0
$ ... -n sandbox-system get sandboxset auto-story-v2   # generation / replicas / available / image
20 8 8 registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:67a46af66d3a53f4034b5c4d2c482a0b411718a3e923194bc547ab9528f3ba8d
```

- **核对说明：**
  - `auto-story-v2` 的 generation 仍为 20，replicas 8，8/8 可用，镜像不变；`welltop/oma-sandbox` 仓库状态为 NORMAL。
  - `oma-scale-test-20261022` 本来就带 `oma.dev/test-only=true`，3d22h 前创建，本次没有动。
