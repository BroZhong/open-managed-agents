# video-production：线上基线、vfs-dev 预演与正式镜像的清单对比

2026-10-26（Asia/Shanghai），#305。本记录覆盖 Environment 定义本身（`sandbox/environments/video-production/`）、vfs-dev 预演，以及 oma-test 上 builder 构建的正式镜像与线上 0.3.3 的逐项对比。oma-test 的构建、Sandbox 内验收、builder 重启、Base Image 演练和 Warm Pool 见 [environments-oma-test-2026-10-26.md](environments-oma-test-2026-10-26.md)；按命令注入（代理、MediaKit）等新 Runner 上线后补。

**结论：**

1. **基线已存档。** 线上 `auto-story-v2` 0.3.3 镜像的预装清单在 [`fixtures/auto-story-v2-0.3.3-inventory.json`](fixtures/auto-story-v2-0.3.3-inventory.json)，用 [`fixtures/sandbox-inventory.py`](fixtures/sandbox-inventory.py) 采集。验收时对构建出的镜像跑同一个脚本，再逐项对比。
2. **`init.sh` 在替身基础镜像上一次构建成功，重跑无变化。** 构建用 ADR 的 Dockerfile 形状和 bind mount 的 `build.env`，脚本用时 178 s。
3. **与线上相比，五个 Python 解释器的包完全一致，dpkg 只多了 `tini`。** 唯一的版本变化是 Debian 的 `ca-certificates` 更新。其余差异都在下文“差异”一节。
4. **原 smoke 的 15 项检查通过 13 项。** 未通过的两项都不是能力缺失：
   - `offline_whisper` 调用的是没有沿用的旧脚本 `prepare-whisper.py`；Whisper 推理本身（两个模型）通过。
   - `vfs_audio_contract_and_embedded_skills` 被 test 策略拦下。线上镜像挂上同一个策略后，这一项也同样失败。
5. **替身不能代表 `oma-media`。** FFmpeg、Node、rg/fd、Pi 工具是从线上镜像复制进替身的。所以 FFmpeg/MediaKit 的检查通过，只说明脚本装的工具能和同一份 FFmpeg 配合，不说明 `oma-media` 正确。
6. **oma-test 正式构建（2026-10-26，`oma-media-0.1.2`）与预演结论一致。** 镜像 `oma-environments@sha256:54d89827…`；对比结果与预演相同，而且 ffmpeg/ffprobe/node/rg/fd 的 sha256 与线上完全相同（`oma-media` 用同一份源码和 configure 选项编译）。逐项见下文“差异”。

## 线上基线

| 项 | 值 |
|---|---|
| 镜像 | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:67a46af66d3a53f4034b5c4d2c482a0b411718a3e923194bc547ab9528f3ba8d`（OCI index；65 层；压缩后 1.87 GB） |
| 采集 | 2026-10-25T17:34:23Z，vfs-dev。`python3 -I docs/verification/fixtures/sandbox-inventory.py <镜像>` |
| 采集方式 | 先 `docker image inspect` 取镜像配置，再在镜像内以 root、`--network none` 用 `/opt/venv/bin/python3 -I` 运行同一脚本。不注入任何变量，不挂载密钥 |
| dpkg | 320 个（状态 `ii`） |
| Python | `/usr/local/bin/python3`：包装脚本 → `/opt/auto-story/venv`，可见 186 个，其中 venv 自有 28 个，其余经 `acs-base.pth` 来自 `/opt/venv`；`/opt/venv`（ACS Jupyter）：173 个；`/opt/auto-story/whisper-venv`：25 个；`/usr/bin/python3`：3 个 |
| 二进制 | vfs-cli v0.3.21、mediakit-cli 0.2.1、ossutil 2.2.0、ffmpeg/ffprobe 9.0.1、node v22.23.2、npm 10.8.2、rg 15.1.0、fd 10.4.2、jq 1.6、git 2.39.5、curl 7.88.1、procps-ng 4.0.2、UnZip 6.00；没有 tini、java、deno、R |
| npm | `/opt/oma-pi-tools`：`@earendil-works/pi-coding-agent` 0.83.0，锁文件 140 个包；`/usr/lib/node_modules`：corepack、ijavascript、npm |
| 文件 | `/etc/pip.conf`（阿里云）、`/etc/oma/proxy.env`、`/opt/auto-story` 下的版本与哈希记录、各 smoke 脚本的 sha256、`/usr/local/bin` 等目录的属主与哈希 |
| `/etc/vfs-cli` | 镜像里是空目录；策略由 Warm Pool 从 ConfigMap 挂载 |
| `/home/user` | 754 个条目，742 个不归 user，几乎都是 `.cache/npm` 下的 root 属主 npm 缓存 |
| 登录 shell 环境 | 只有 `HOME`、`PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games`。镜像 ENV（代理、`MEDIAKIT_*`、缓存路径）只有 PID 1 能看到 |

- **采集脚本不读取密钥。** 它在镜像内运行，网络关闭，不挂载 Secret。
- **写入前检查过 fixture。** 搜索 AccessKey、私钥、`password`、`Bearer` 这类特征，都没有命中。
- **镜像 ENV 里的代理值照原样保留。** 它们是公开的集群地址，不是密钥。

**与 issue 不符、按线上镜像处理的地方：**

- **线上镜像带离线 Whisper，issue 的脚本清单里没有。** 0.3.x 的父镜像 0.3.0（`6f5eedfc…`）带 faster-whisper venv 和 `base.en` / `small` 模型。业务 Skill `story-audio`（`welltop-cn/auto-story-skills`）直接运行 `/opt/auto-story/whisper-venv/bin/python3`，并读取 `/opt/auto-story/models/{base.en,small}`。原 smoke 也有 `offline_whisper` 检查。所以 `video-production` 起初照装。**2026-10-26 维护者决定移除**（venv 与模型，约 630 MB 模型加 venv），见下文“差异”与“移除 Whisper 后重建”。
- **main 的配方不是线上配方。** main 上的 `sandbox/auto-story-v2/` 是 0.2.3，还要求排除 Whisper；线上配方在分支 `codex/sandbox-runtime-0.3.1`。以线上为准。

## Environment 定义的判断

- **代理变量写成平台默认的明文值，不引用 `base-secret`。**
  - `base-secret` 有 25 个键（2026-10-26 只读取了键名），其中 6 个是 `HTTP(S)_PROXY` / `NO_PROXY` 及其小写形式。值是 10-20 从 `proxy.env` 合并进去的。
  - 只比较、不打印值的结果：四个代理键都等于 sing-box 地址；`NO_PROXY` 等于 `localhost,127.0.0.1,::1,.svc,.cluster.local`，不含阿里云后缀。
  - 引用它就满足不了“阿里云镜像源与 OSS 内网直连”。交接记录写明，运行时代理作为平台默认变量是维护者的选择。
- **其余 19 个键按名称一一声明为平台密钥。**
  - 其中包括只有这个 Secret 提供的非密钥设置：`MEDIAKIT_SURFACE`、`MEDIAKIT_RUNTIME`（值与 `sandbox-env.ts` 的默认值相同）、`OSSUTIL_BIN`（`/usr/local/bin/ossutil`）、`RUNTIME_ENV`、`IS_TEST`、`OSS_READ_*`。
  - `OPENGROVE_WW_*` 也照样声明：ADR 说失效的是按 Agent 注入的那条路径，这两个键在 `base-secret` 里存在，今天会传给每个 Sandbox。
- **不声明的变量：**
  - `base-secret` 现在没有文件类条目，以前挂载的 `source.env` 已不在 Secret 里。
  - 旧 SandboxSet 以可选引用指向 `GEMINI_API_KEY` 和 `GEMINI_AUDIO_MODEL`，但 Secret 里没有这两个键。
  - Host 的 Workspace 变量（`HOME`、`MEDIAKIT_OUTPUT_PATH` 等）属于系统保留。
- **`NO_PROXY` 只写了 issue 要求的后缀。**
  - 没有加业务域名：sing-box 已经按规则把 `welltop.tech`、`creativefitting.cn` 直连。
  - 没有加 `.alicdn.com`：从 ACS 直连没有实测过。

## vfs-dev 预演

**环境：** vfs-dev（x86_64，Docker 29.3.1，BuildKit v0.28.1），目录 `~/workspace/yuzhong/oma-env-305-video-production/`。

**基础镜像是本地替身，没有推送。** `welltop/oma-sandbox` 里还没有 `oma-media` 标签。替身按 clean recipe 的 runtime 阶段近似 `oma-media`，包含：

- 固定 digest 的 ACS `code-interpreter@sha256:b53bc461…`；
- 阿里云 apt 源；
- FFmpeg 运行库、fontconfig 与字体、procps、unzip、tini；
- 从线上镜像复制的 ffmpeg/ffprobe/node/rg/fd 和 `/opt/oma-pi-tools`；
- `ENTRYPOINT tini -g --`。

第一次预演只在 ACS 基础镜像上加了阿里云源。`import cv2` 因缺 `libgthread-2.0.so.0`（`libglib2.0-0`）失败。线上这个包随 FFmpeg 运行库（harfbuzz）进来，`oma-media` 应当带它。

**Dockerfile 与 ADR 相同，只是去掉了 `write-manifest`**（替身里没有 `/opt/oma/bin/write-manifest`），用上面的采集脚本代替：

```dockerfile
FROM oma-env-305-standin:local
RUN --mount=type=bind,source=init.sh,target=/tmp/oma-init.sh \
    --mount=type=bind,source=build.env,target=/tmp/oma-build.env \
    cd /home/user && set -a && . /tmp/oma-build.env && set +a && \
    bash -euo pipefail /tmp/oma-init.sh
RUN find /home/user \( ! -user user -o ! -group user \) -exec chown -h user:user {} + \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*
LABEL dev.oma.environment=env_video_production dev.oma.build=dryrun-305-vfs-dev
```

**代理：** `build.env` 是 `HTTP(S)_PROXY`（含小写）`=http://172.17.0.1:7890`，`NO_PROXY`（含小写）为 issue 要求的列表。

- vfs-dev 直连 GitHub release 超时（50 s，两次），只能经本机 sing-box（`0.0.0.0:7890`，容器内用 docker0 地址访问）。
- 阿里云 pip/apt 源和 `gosspublic.alicdn.com` 直连可用；Hugging Face 经代理可用。
- 这和 ACS 不同：ACS 上 builder 用 `sing-box.oma-infra.svc.cluster.local:7890`。

**结果：**

| 检查 | 结果 |
|---|---|
| 构建 | 成功，`init.sh` 用时 178 s：apt 23 s（新装 32 个包，与 0.3.1 记录一致）、三个 CLI 9 s、Gemini venv 21 s、Whisper venv 47 s、模型 75 s（630 MB，经代理）、自检 2 s |
| 新层 | 未压缩 1.46 GB，压缩后约 0.86 GB，大头是模型和 Whisper venv |
| 校验和 | 三个归档、三个二进制、10 个模型文件全部 `OK` |
| 镜像配置与 history | 没有 `172.17.0.1`、`sing-box`、`npmmirror`；Env 与替身逐项相同（没有代理 ENV）；history 只有 RUN 原文和 `/tmp/oma-build.env` 路径 |
| 重跑幂等 | 在构建好的镜像里以 root、`--network none` 重跑 `init.sh`：不下载、pip 全部 already satisfied、自检通过，`/home/user` 没有非 user 属主文件 |
| `/home/user` 属主 | 没有非 user 属主文件，`/tmp` 为空 |
| 普通用户导入 | `python` 和 `python3 -I`：`import ctypes, cv2, scenedetect, PIL, fontTools, google.genai, numpy` 成功，`libGL.so.1` 加载成功；版本为 cv2 4.11.0、scenedetect 0.7.1、Pillow 11.3.0、fonttools 4.61.1、numpy 1.26.4 |
| vfs-cli 策略 | 目录 root:root 755；`policy.json` root:root 644，22 字节，sha256 `3af5e4d4…` 与 ConfigMap 相同。普通用户追加、改名、新建文件都是 Permission denied。`RUNTIME_ENV=PRO … vfs-cli project query … --force --yes` 返回 exit 2 / `environment_policy_conflict`，`details.policy_environment=test`，`policy_path=/etc/vfs-cli/policy.json` |
| 原 smoke（线上 `/usr/local/bin/auto-story-smoke`，普通用户、无网络、最小 PATH，`--require-env`） | 15 项中 13 项通过。`offline_whisper` 失败，原因是缺 `/opt/auto-story/prepare-whisper.py`；`vfs_audio_contract…` 失败，原因是被 test 策略拦下（要求 `VFS_PIXEL_DIRECTOR_URL` 为 `https://pre-pixel-director.creativefitting.cn`） |
| 同一 smoke，用 tmpfs 遮住 `/etc/vfs-cli` | 只剩 `offline_whisper` 失败，VFS 检查通过 |
| 线上镜像 + 挂载同一策略 | `vfs_audio_contract…` 同样失败，所以这是策略本身的行为，不是回归 |
| Whisper 推理（与 Skill 相同：CPU int8、`local_files_only`、`HF_HUB_OFFLINE=1`） | `base.en`、`small` 都通过 |
| 0.3.1 runtime-overlay smoke | libGL、SceneDetect（第 20 帧切点）、Pillow、fonttools、pip 镜像、NumPy/OpenCV 版本都通过；最后读取 `/etc/oma/proxy.env` 时失败，这个文件按设计不再生成 |
| Pi 工具 smoke | 0.83.0，7 个工具都通过（来自替身，不是脚本装的） |
| ACS Jupyter 启动 | 3 s 内 `/api/status` 正常；PID 1 是 `tini -g -- bash /root/.jupyter/start-up.sh` |

## 差异：正式镜像相对线上 0.3.3

正式镜像 `oma-environments@sha256:54d89827…`（oma-test builder 构建，`oma-media-0.1.2`）对线上 `oma-sandbox@sha256:67a46af6…`。两份清单都用 `fixtures/sandbox-inventory.py` 采集：正式镜像在 vfs-dev 上 pull 后以 root、`--network none` 运行（2026-10-25T20:28:29Z）。没有列出的项完全相同。

| 项 | 线上 | video-production | 原因 |
|---|---|---|---|
| dpkg `tini` | 无 | 0.19.0-1+b3 | `oma-base` 的入口（ADR-0024） |
| dpkg `ca-certificates` | 20250419~deb12u1 | ~deb12u2 | 构建 Base Image 时 bookworm 的更新，由 Base Image 决定 |
| 其余 319 个 dpkg 包 | — | 相同 | libgl1 由脚本按线上版本安装，其余来自 Base Image |
| Python（5 个解释器：Gemini venv 186、Whisper venv 25、`/opt/venv` 173、`/usr/bin/python3` 3、`/usr/local/bin/python3` 186） | — | 包与版本全部相同 | venv 锁定为线上的 `pip freeze`，其余作为约束 |
| npm（`/opt/oma-pi-tools` Pi 0.83.0、全局包） | — | 相同 | Pi 工具运行时由 `oma-base` 提供，版本与 Host 一致；预期中的“Pi 版本差异”实际没有出现 |
| 二进制 ffmpeg、ffprobe、node、rg、fd | — | sha256 相同 | `oma-media` 用同一份 FFmpeg 源码与 configure 选项编译；node/rg/fd 来自 `oma-base` 的固定发布包 |
| 二进制 vfs-cli、mediakit-cli、ossutil | — | sha256 相同；vfs-cli 属主 501:50 → root:root | 脚本校验归档和二进制哈希后用 `install -o root` 安装 |
| `python3`/`pip3` 的解析结果 | `/usr/local/bin/…`（包装脚本） | `/opt/venv/bin/…` | 只在按镜像 ENV 的 PATH 解析时不同（ACS 的 PATH 以 `/opt/venv/bin` 开头）。登录 shell 的 PATH 两边相同，命令里的 `python3` 都是指向 Gemini venv 的包装脚本（sha256 相同） |
| 镜像 ENV | 代理 6 个、`HOME`、`WORKSPACE_DIR`、`MEDIAKIT_*`、`NODE_PATH`、`NPM_CONFIG_*`、`PIP_CACHE_DIR`、`PYTHONPATH`、`STORY_SEED_WORKSPACE`、`TMPDIR`、`XDG_CACHE_HOME` | 只有 ACS 的 ENV | ADR-0024：镜像不带变量。镜像 ENV 只有 PID 1 看得到；命令里的代理和 `MEDIAKIT_*` 来自本定义的变量（按命令注入，待新 Runner），路径类变量来自 Host 的 Workspace 变量 |
| 入口 | `bash /root/.jupyter/start-up.sh` | `tini -g --` + 原命令 | ADR-0024 |
| Labels | 0.3.3 的标签 | `oma-media` 的标签 + `dev.oma.environment`、`dev.oma.build`、`dev.oma.base-image` | builder 记录来源 |
| 层数 / 压缩大小 | 65 / 1.875 GB | 43 / 1.882 GB | 新层主要是 Whisper 模型与 venv（约 0.86 GB） |
| `/etc/oma/proxy.env` | 有 | 无 | 代理由按命令注入的平台默认变量提供 |
| `/etc/vfs-cli/policy.json` | 镜像里是空目录，运行时由 ConfigMap 挂载 | 镜像内文件，root 0644，字节与 ConfigMap 相同 | Warm Pool 不再挂载 ConfigMap；普通用户同样不能修改 |
| `/opt/auto-story` 下的记录（`versions.json`、`tool-sha256.txt`、`debian-packages.txt`、`python-packages.txt`、`whisper-packages.txt`、`requirements.txt`、`whisper-requirements.txt`、`runtime-overlay/`、`vfs-cli-0.3.20/`、`vfs-cli-0.3.21/`） | 有 | 无 | 改由构建清单 `/opt/oma/manifest.json` 记录 |
| 离线 Whisper：venv `/opt/auto-story/whisper-venv`（25 个包，faster-whisper 1.2.1、ctranslate2 4.8.2）、模型 `/opt/auto-story/models/{base.en,small}`（约 630 MB），以及辅助 `prepare-whisper.py`、`whisper-models.json`、`/usr/local/bin/auto-story-transcribe` | 有 | 无 | **预期差异：Whisper venv + models removed — maintainer decision 2026-10-26; the story-audio Skill's offline transcription is no longer available in video-production.** 辅助脚本本来就是旧镜像命令，没有沿用 |
| `/usr/local/bin/auto-story-smoke`、`runtime-overlay/smoke.py` | 有 | 无 | 验收脚本不进镜像，验收时上传执行 |
| `/opt/pi-search` | 有（rg/fd 版本记录） | 无；新增 `/opt/oma`（`bin/write-manifest`、`images/`、`smoke/`、`manifest.json`） | 版本由 `/opt/oma/images/oma-base.json` 和清单记录 |
| `/home/user` | 754 个条目，742 个不归 user（root 属主的 npm 缓存、`.local`、`.mediakit`） | 3 个 skeleton 文件，全部归 user | `oma-base` 的 home 不带缓存，builder 构建后修正归属（ADR-0024） |

## oma-test 验收：已完成与待完成

**已完成**（2026-10-26，详见 [environments-oma-test-2026-10-26.md](environments-oma-test-2026-10-26.md)）：

- **构建与就绪：** builder 构建 347.8 s 后就绪，`init.sh` 部分 194 s，其中包括从 ACS 经 sing-box 下载 630 MB 模型；正式镜像的清单对比见上表。
- **原 smoke：** 在 Sandbox 里以普通用户跑，15 项过 13 项。两项失败按原样记录、没有改 smoke：`offline_whisper` 调用旧脚本（推理本身单独测过，通过）；VFS 检查被 test 策略拦下。
- **Base Image 带的东西：** `oma-media-0.1.2` 带 procps、unzip、fontconfig、`libglib2.0-0`；导入 cv2 和 smoke 都通过。
- **策略文件、Warm Pool、ImageCache、builder 重启、Base Image 演练：** 通过。

**待新 Runner（迁移 0029 之后）：**

- **代理：** 在 Sandbox 命令里，GitHub 经 sing-box，阿里云镜像源和 OSS 内网直连（对照 sing-box 日志里的 Pod IP）。依赖 #307 的按命令注入。
- **平台密钥：** MediaKit 真实调用成功，证明平台密钥经按命令注入到达 Sandbox。

## 复现

```bash
# vfs-dev，一个空目录
python3 -I docs/verification/fixtures/sandbox-inventory.py <镜像> > inventory.json
# 预演：Dockerfile 见上，上下文里只有 init.sh 和 build.env
docker build --platform linux/amd64 --no-cache -t oma-env-305-video-production:dryrun .
```

本地镜像 `oma-env-305-standin:local`、`oma-env-305-video-production:dryrun` 只在 vfs-dev 上，没有推送。集群只做了只读访问：`base-secret` 只读键名，值只做比较、没有打印；另外读了 SandboxSet `auto-story-v2` 和 ConfigMap `vfs-cli-policy-test-v1`。
