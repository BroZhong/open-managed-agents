# oma-test Warm Pool：过渡池镜像、ImageCache、领取与原地换镜像实测（#301 第二阶段）

2026-10-26（Asia/Shanghai，下文时间为 UTC）在 agent-platform 上把 oma-test 切到新的 Warm Pool `oma-test-sandbox`，Runner 每次领取都带镜像 digest。第一阶段（Base Image、Host 代码、清单）见 [base-images-2026-10-26.md](base-images-2026-10-26.md)。逐样本数据见 [JSON 证据](warm-pool-oma-test-2026-10-26.json)。

**结论：**

1. **过渡池镜像** `oma-sandbox:video-production-transitional-20261026` = `oma-media-0.1.2` + 未改动的 `video-production/init.sh`（`15cd24e9…`），按 ADR-0024 的 Dockerfile 形状构建。digest `sha256:2dd85aa3e0317bd06735e2ebc6ed6ef5db075b7b0c2b3c7f83060704a960f2e4`，44 层，压缩 1.84 GB（其中 Environment 层 856 MB，主要是 Whisper 模型与 venv）。镜像配置的 `Env` 与 ACS 基础镜像相同，history 里没有构建代理的值。
2. **验收**：线上 auto-story smoke 15 项过 13 项，两项失败与 #305 预演相同、都不是能力缺失；scenedetect/cv2/PIL/fontTools 导入与切点检测、vfs-cli test 策略、FFmpeg 的 libass/OpenH264、Pi 七个工具都通过。与线上 0.3.3 的清单相比：dpkg 只多 `tini`（另有 `ca-certificates` 小版本更新），5 个 Python 解释器的包、npm、字体、登录 shell 环境完全一致，`/home/user` 从 754 个条目（742 个 root 属主的 npm 缓存）变成 3 个。
3. **ImageCache** `imc-uf67ai761p6lax4fl3mn`：创建到 Ready 3 min 51 s。之后每个池 Pod 都命中缓存（`ImageCacheHit`），从创建到主容器启动约 39 s；#299 未建缓存时补货要 73–81 s。
4. **Warm Pool**：`sandbox-system/oma-test-sandbox`（1 副本）已 apply，模板不含 base-secret pod env，也不再挂 vfs-cli 策略 ConfigMap（策略在镜像里）。`auto-story-v2` 没有任何改动（generation 20，8/8）。
5. **迁移 0026** 只应用到 `oma_test`。
6. **部署**：oma-test 现在跑 `oma-server@sha256:fc7eebd0…`（提交 `6c79c1e`）和 `oma-web@sha256:e8273730…`，`SANDBOX_TEMPLATE=oma-test-sandbox`，`SANDBOX_IMAGE` 为过渡镜像。回滚目标：`oma-server:afcea76b87ed`、`oma-web@sha256:b479ad63…`，Runner 配置改回 `auto-story-v2`（见“回滚”）。
7. **领取实测**：
   - 同镜像领取不重启容器（restartCount 0），create 161–222 ms；
   - 换成 `oma-base-0.1.2` 原地换镜像 4.1–4.6 s，旧容器在 Killing 的同一秒以 143 退出，不再等 30 s 宽限期；
   - 无库存时冷启动 38.9 s。
8. **修了一个 bug**：第一版按 `/proc/uptime` 判断是否换镜像，但 ACS 给每个容器单独的 uptime（PID 1 从 0 开始），所以每次换镜像都被记成了 `swapped: false`。现在改为用 Pod 级文件 `/etc/hostname` 的 ctime 算 Pod 年龄（提交 `6c79c1e`）。修复后三种领取都判断正确。
9. **真实 Session**：一个 Turn 内用 bash 调用 ffmpeg 9.0.1、vfs-cli v0.3.21、mediakit-cli、cv2/scenedetect，读到 test 策略。命令能看到全部 36 个变量名：25 个 base-secret 键加 11 个 Workspace 变量，与线上 auto-story-v2 Sandbox 创建时注入的变量名相同。`span.sandbox_prepare_end` 带有 `image`、`swapped: false`、`claimMs`。

## 1. 过渡池镜像

构建在 vfs-dev 的 `~/workspace/yuzhong/oma-env-301-transitional/`，上下文里只有 `init.sh`（从提交 `88c91f1` 复制，sha256 一致）、`build.env` 和下面的 Dockerfile：

```dockerfile
FROM registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:9a57f901b5df1aa280390b0256aac93c8e724aacb1f9f2831e9ccd441d90ac00
RUN --mount=type=bind,source=init.sh,target=/tmp/oma-init.sh \
    --mount=type=bind,source=build.env,target=/tmp/oma-build.env \
    cd /home/user && set -a && . /tmp/oma-build.env && set +a && \
    bash -euo pipefail /tmp/oma-init.sh
RUN /opt/oma/bin/write-manifest > /opt/oma/manifest.json \
    && find /home/user \( ! -user user -o ! -group user \) -exec chown -h user:user {} + \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*
LABEL dev.oma.environment=env_video_production dev.oma.build=transitional-301-20261026
```

- `build.env` 只有 6 个代理变量：`HTTP(S)_PROXY` 及小写形式为 `http://172.17.0.1:7890`，即 vfs-dev 本机的 sing-box，在容器内经 docker0 访问；`NO_PROXY`/`no_proxy` 用定义里的列表。没有密钥，也没有 platform secret。
- 构建用 271 s，其中 `init.sh` 约 186 s（模型经代理下载）。推送用 26 s，只上传两层新层。
- 镜像 `Env` 与 ACS 基础镜像逐项相同；history 只出现 `/tmp/oma-build.env` 这个路径，没有 `172.17.0.1`、`7890`、`sing-box`、`npmmirror`。
- 启动检查：Jupyter 3 s 就绪；PID 1 是 `tini -g --`；SIGTERM 后 124 ms 以 143 退出；`/home/user` 只有 skeleton 文件，没有非 user 属主文件；`/opt/oma/manifest.json` 存在。

| 验收（以 `user`、无网络、最小 PATH 运行） | 结果 |
|---|---|
| 线上 `auto-story-smoke`（从 0.3.3 镜像复制，`b0492480…`） | 15 项中 13 项通过。`offline_whisper` 失败：调用的旧脚本 `prepare-whisper.py` 不再保留；`vfs_audio_contract…` 失败：被 test 策略拦下，线上镜像加同一策略也一样。两项都与 #305 预演一致 |
| 0.3.1 runtime-overlay 的 `media_python` | libGL 加载；SceneDetect 0.7.1 在第 20 帧检出切点；Pillow 11.3.0；fonttools 4.61.1 |
| 导入 | cv2 4.11.0、numpy 1.26.4、PIL 11.3.0、fontTools 4.61.1、scenedetect 0.7.1、google.genai |
| vfs-cli 策略 | `/etc/vfs-cli/policy.json` 为 root 0644，内容 `{"environment":"test"}`，user 写入被拒；`RUNTIME_ENV=PRO … --force --yes` 返回 exit 2 和 `environment_policy_conflict` |
| oma-media smoke | 6/6：OpenH264、x264、经 libass 的中文字幕、字体 |
| 工具 | vfs-cli v0.3.21、mediakit-cli 0.2.1、ossutil 2.2.0、faster-whisper 1.2.1 / ctranslate2 4.8.2、模型 `base.en` 与 `small`；Pi 0.83.0 七个工具 |

**清单对比**：用 `docs/verification/fixtures/sandbox-inventory.py` 采集，与 `fixtures/auto-story-v2-0.3.3-inventory.json` 比较。逐项解释留给 #305。

- dpkg：320 → 321 个，只多了 `tini`；`ca-certificates` 从 `20250419~deb12u1` 升到 `~deb12u2`。
- Python：5 个解释器的包集合完全相同（Gemini venv、Whisper venv、`/opt/venv`、系统 python、`/usr/local/bin/python3`）。
- npm、字体、用户、登录 shell 环境：相同。
- 二进制：集合相同，只多 `tini`。`python3`/`pip3` 只在按镜像 ENV 的 PATH 解析时不同（`/opt/venv/bin` 在前）；按登录 shell 的 PATH 解析时相同。
- `/home/user`：754 个条目（742 个 root 属主）→ 3 个，全部归 `user`。
- 文件：缺少的是定义有意不带过来的 `/opt/auto-story` 记录、smoke 副本和 `proxy.env`。

## 2. ImageCache 与 Warm Pool

- `aliyun acc create-image-cache`，镜像为上面的 digest；网络配置与生产缓存 `imc-uf6c2ys46pzt3c3grd74` 相同（同一安全组、3 个 vSwitch）；不传镜像凭证；标签 `oma.dev/test-only=true`、`oma.dev/issue=301`。18:16:48 创建，18:17:34 开始拉取，18:20:39 Ready，Size 5。
- 18:21:54 apply `sandbox/warm-pool/oma-test-sandbox.yaml`，18:22:32 可用（38 s）。第一个 Pod：18:22:03 `ImageCacheHit`；三个 sidecar（agent-runtime、csi、csi-agent）拉取约 16 s；18:22:33 主容器启动。后续每次补货约 38–39 s，每次都命中缓存。
- 池 Pod 的主容器环境只有平台注入的 `ENVD_DIR`、`GODEBUG`、`POD_UID`，没有 base-secret。
- 清单不再挂 `vfs-cli-policy-test-v1`：过渡镜像自带同样字节的 `/etc/vfs-cli/policy.json`；其他 Environment 领取这个池时，也不应被强加这个策略。

## 3. 迁移 0026（只对 oma_test）

`node deploy/scripts/migration-for-env.mjs test deploy/migrations/0026_environments.sql`（把 `oma.` 改为 `oma_test.`、把 `oma_app` 改为 `oma_test_app`），去掉 `BEGIN;`/`COMMIT;` 后，用 Supabase MCP 的 `execute_sql`（实例 `ra-lvyt8wkxiid4a76`）一次执行，保留 `SET LOCAL lock_timeout = '5s'`。核对结果：

- `oma_test.environments`、`oma_test.environment_builds` 及 6 个索引已建；
- `oma_test_app` 有 SELECT/INSERT/UPDATE，没有 DELETE，有序列 USAGE；
- 两表都为空；`oma.environments` 不存在，生产 schema 未动。

## 4. 部署（只动 oma-test）

| | 之前（回滚目标） | 现在 |
|---|---|---|
| oma-api / oma-runner | `oma-server:afcea76b87ed` | `oma-server@sha256:fc7eebd05e6b076c9664cf337b638cc24bdf1946c43509af3c8ee7bad01360bb`（`6c79c1ed44a4`） |
| oma-web | `oma-web@sha256:b479ad63dd99faa1bd1f5fa01d009107be4b836cd241a14b573eba1ab170409c` | `oma-web@sha256:e82737306923f4bae21b6a9dbc2ca357f8a280a5f89b4055db22284ffe07fea9` |
| Runner `SANDBOX_TEMPLATE` / `SANDBOX_IMAGE` | `auto-story-v2` / 无 | `oma-test-sandbox` / `…@sha256:2dd85aa3…` |

- 构建：vfs-dev 的 `~/workspace/yuzhong/oma-env-301-d7cd070`（git bundle），从主 checkout 复制了 `.buildx-cache`，运行 `bash build.sh --push server web`。
- 第一次部署（18:22:50）用集成分支 `88c91f1`（server `sha256:4cf7efae…`）。在它上面测出 swap 判定错误后，从修复提交 `6c79c1e` 重新构建 server（web 不变）再部署。
- 部署方式：`render.mjs test` 渲染，`kubectl diff` 只有 3 个镜像和 Runner ConfigMap 的两个键，`kubectl apply` 后 rollout 正常，`/api/health` 正常，Runner 与 API 日志没有错误。

## 5. 领取实测（Runner Pod 内运行部署后的 `E2BSandboxClient`；kubectl 只读观测）

**修复后**（server `6c79c1e`；池子用过渡镜像，池 Pod 就绪 ≥ 20 s 后再领取）：

| 路径 | n | 网关 create（`claimMs`） | `swapped` | restartCount | 时间分解 |
|---|---:|---|---|---|---|
| 同镜像 | 5 | 161–222 ms | false ×5 | 0 | 没有 Killing/Pulling；首条命令 15–16 ms |
| 换成 `oma-base-0.1.2` | 3 | 4,091 / 4,339 / 4,605 ms | true ×3 | 1 | 领取→Killing 1.3–1.8 s；Killing→旧容器以 143 退出 0 s；退出→新容器启动 1.0 s；启动→create 返回 1.6–2.0 s |
| 无库存（两个并发 create） | 1+1 | 38,946 ms / 229 ms | false / false | 0 / 0 | 慢的那个是网关为本次领取新建的 Pod（Pod 创建时间 = 领取时间，39 s 后启动），即冷启动；另一个是普通领取 |

- **没有 30 s 等待。** 换镜像时旧容器在 Killing 的同一秒以 143 退出，与 #299 用 base-tini 测的一致（3.6–5.2 s）。`oma-base` 的层都已在池 Pod 里，所以这次换镜像不需要拉取新层。
- **修复前**（server `88c91f1`，同样的池子）：同镜像 3 次判定正确；换镜像 2 次都记成了 `swapped: false`，而 restartCount 是 1、旧容器以 143 退出。
- **原因**：在换过镜像的 Sandbox 里，`/proc/uptime` 是 15.79 s，`/proc/stat` 的 `btime` 等于容器启动时间，PID 1 的 starttime 是 0。也就是说 ACS（内核 `5.10.134-18.0.12.lifsea8`）给每个容器单独计 uptime，“内核早于本次领取启动”这个判断永远不成立。`/etc/hostname`、`/etc/hosts`、`/mnt/envd/*` 是 Pod 级文件，容器重启后保留，ctime 等于 Pod 启动时间：同一个 Sandbox 的 Pod 年龄 145.4 s，容器年龄 91.1 s。
- **修复**（`6c79c1e`，有单元测试）：探测改为 `cat /proc/uptime /proc/1/stat && getconf CLK_TCK && date +%s.%N && stat -c %Z /etc/hostname`。判断规则：PID 1 早于本次领取启动 → 普通领取；PID 1 晚于领取，但 Pod 早于领取（Pod 年龄 > 已过时间 + 1 s）→ 换镜像；两者都晚于领取 → 冷启动。

## 6. 真实 Session

在 oma-test API Pod 里，用一次性租户的临时 API key（用完吊销）创建 Agent（`openai-codex/gpt-5.6-sol`，开启 Sandbox）和 Session。要求它用 bash 执行一条命令：打印工具版本，并对每个变量名只打印 `=set`/`=unset`，不打印值。

- 结果：Turn 用时 14.1 s，模型回复 `RESULT:<marker>`。
- 工具与策略：ffmpeg 9.0.1、vfs-cli v0.3.21、`mediakit-cli --help` 正常、`python-ok` cv2 4.11.0 scenedetect 0.7.1、策略 `{"environment":"test"}`。
- **变量名**：36 个全部为 `set`，即 25 个 base-secret 键（`GEMINI_VIDEO_MODEL` … `no_proxy`）加 11 个 `WORKSPACE_ENV`（`HOME` … `TMPDIR`）。这与第一阶段从两个线上 `auto-story-v2` Sandbox 的 `init-runtime-request` 读到的 36 个变量名相同，所以命令看到的变量名没有变化。
- **span**：`span.sandbox_prepare_end` = `{outcome: ready, sandboxId: …oma-test-sandbox-5dpnh, image: …@sha256:2dd85aa3…, swapped: false, claimMs: 559, durationMs: 960}`。这里的 `claimMs` 比裸领取长，因为真实 Session 带 Workspace CSI 挂载。
- Session 结束后两个 Sandbox 都已被回收；`GET /v1/sessions/{id}` 的 `sandbox.state` 为 `ready`，没有 `last_error`。

## 回滚

```bash
export KUBECONFIG=~/.kube/agent-platform-config
# 在 deploy/environments/test/kustomization.yaml 里把 SANDBOX_TEMPLATE 改回 auto-story-v2
# （旧镜像不读 SANDBOX_IMAGE，它可以留着），然后：
node deploy/scripts/render.mjs test afcea76b87ed afcea76b87ed sha256:b479ad63dd99faa1bd1f5fa01d009107be4b836cd241a14b573eba1ab170409c > /tmp/oma-test.yaml
kubectl diff -f /tmp/oma-test.yaml; kubectl apply -f /tmp/oma-test.yaml
# 池子与缓存可以留着；要删就先把 SandboxSet 缩到 0 再删除，再删 ImageCache imc-uf67ai761p6lax4fl3mn。
```

迁移 0026 是纯增量，旧镜像不读这两张表，不需要回滚。

## 清理与边界

- 测量 Sandbox（metadata `oma.dev/test-only=oma-env-301-measure`）共 15 个，全部按 id kill，并用 kubectl 复查，没有残留。网关按 metadata 列表的过滤会被 SDK 多转义一次（客户端代码里已有注释），所以清理靠 id，不靠 sweep。
- 两个测试 Session 已终止，Sandbox 已回收；临时 API key 已吊销。测试租户的两个 Agent 留在 `oma_test`。
- 同时存在的测试 Sandbox 最多 5 个（含池 Pod，在并发冷启动那一步）。没有改动 `auto-story-v2`、`base-secret`、`oma-infra` 或生产 schema。ImageCache 与 `oma-test-sandbox` 保留，供 oma-test 继续使用。
