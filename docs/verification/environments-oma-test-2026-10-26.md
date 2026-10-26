# Environments 在 oma-test 的验收：oma-image-builder 与内置 video-production（#303、#305）

2026-10-26（Asia/Shanghai，下文时间为 UTC），agent-platform 集群 `oma-test`，schema `oma_test`。父 issue #298，设计 [ADR-0024](../adr/0024-environments.md)。逐个构建的时间、检查原文见 [JSON 证据](environments-oma-test-2026-10-26.json)。Base Image 与 Warm Pool 的前置工作见 [base-images-2026-10-26.md](base-images-2026-10-26.md)、[warm-pool-oma-test-2026-10-26.md](warm-pool-oma-test-2026-10-26.md)，video-production 的定义、基线与逐项清单对比见 [video-production-2026-10-26.md](video-production-2026-10-26.md)。

**结论：**

| # | 验收项 | 结果 |
|---|---|---|
| 303-1 | 创建带脚本的环境 → 就绪；CLI 与控制台看得到日志和预装清单 | 通过 |
| 303-2 | 脚本出错 → 构建失败，日志指出出错行；修正后就绪 | 通过 |
| 303-3 | 构建中修改脚本 → 旧构建被取代，最终镜像对应最新脚本 | 通过 |
| 303-4 | 镜像 history/配置无密钥；构建 Pod 无平台密钥 | 通过 |
| 303-5 | 构建编排有不依赖集群的测试 | 通过（`image-builder*.test.ts`） |
| 303-6 | builder 有自己的清单和最小权限 | 通过；Role 的风险见下文 |
| 305-1 | video-production 就绪；原 smoke 以普通用户通过；scenedetect/cv2/PIL/fontTools + libGL | 通过（smoke 13/15，两项失败不是能力缺失） |
| 305-2 | 清单与线上 0.3.3 逐项对比，每处差异有原因 | 通过 |
| 305-3 | `/etc/vfs-cli/policy.json` 内容一致、普通用户不可改、vfs-cli 读到 test 策略 | 通过 |
| 305-4 | Agent 命令默认带代理变量 | 待新 Runner（下一阶段） |
| 305-5 | MediaKit 调用成功（平台密钥按命令注入） | 待新 Runner（下一阶段） |
| 305-6 | 重复启动 builder 不重复写入；定义不变不重建 | 通过 |
| 305-7 | Base Image digest 变化只重建相关环境，失败互不影响 | 通过（失败隔离由单元测试覆盖） |
| 305-8 | Warm Pool 镜像随之更新；发版顺序写进部署文档 | 通过；ImageCache 已建 |

## 1. 部署状态

| 组件 | 镜像 | 说明 |
|---|---|---|
| oma-api、oma-image-builder | `oma-server@sha256:61e25740…`（集成分支 `017d2b18`） | builder 是新增的第三个角色，1 副本，`Recreate` |
| oma-web | `oma-web@sha256:d99b9db6…`（`017d2b18`） | 控制台 `/environments/:id` |
| oma-runner | `oma-server@sha256:fc7eebd0…`（`6c79c1e`），未动 | 新 Runner 需要迁移 0029，不在本阶段 |

- 迁移 0026、0028 已应用到 `oma_test`；0029 未应用。
- builder ConfigMap：`BASE_IMAGE_OMA_BASE` = `oma-base-0.1.2`（`618d3a4f…`），`BASE_IMAGE_OMA_MEDIA` = `oma-media-0.1.2`（`9a57f901…`），`WARM_POOL_ENVIRONMENT=env_video_production`，`WARM_POOL_IMAGE_CACHE=none`，`SANDBOX_TEMPLATE=oma-test-sandbox`。
- 演示用一次性租户 `env-demo-303-202610252009` 和它的临时 API key，经 `oma-cli`（本分支的 `cli/dist`）访问 `https://agentry-test.welltop.tech/api`。

## 2. #303：构建、失败、取代

两个演示 Environment，都在 `oma-base`：`demo-ok`（apt 装 `sl`、pip 装 `tabulate`、经构建代理从 GitHub 下载、写 `/etc/profile.d`、在 `/home/user` 以 root 建文件；普通变量 `DEMO_PLAIN`，密钥 `DEMO_SECRET`）和 `demo-fail`（第 5 行调用不存在的命令）。每行一个构建，时间单位 s（Pod 启动 = 领取构建到 build 容器开始拉 Base Image）：

| seq | Environment | 结果 | 总计 | Pod 启动 | 拉取 | 构建 | 推送 | 校验（领取） |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 2 | demo-ok v1 | 就绪 | 89.2 | 25.3 | 43 | 9 | 4 | 3.7（3,467 ms，换镜像） |
| 3 | demo-fail | 构建失败 | 88.1 | 31.3 | 46 | 脚本失败 | — | — |
| 4 | demo-fail 修正 | 就绪 | 106.5 | 44.2 | 43 | 4 | 4 | 3.6（3,458 ms，换镜像） |
| 5 | demo-ok v2 | 被取代 | 49.3 | 33.2 | 拉取中被停 | — | — | — |
| 6 | demo-ok v3 | 就绪 | 92.0 | 25.2 | 45 | 7 | 4 | 3.9（3,745 ms，换镜像） |
| 11 | demo-fail 显式 rebuild | 就绪 | 95.3 | 35.1 | 43 | 4 | 4 | 4.0（3,811 ms，换镜像） |

- **就绪路径**：一个 90 s 左右的普通构建里，拉 Base Image 占一半（43–46 s，每次都完整拉取，见“观察到的问题”）。校验从 Warm Pool 领一个 Sandbox 原地换成新镜像，检查 envd、`bash` 以普通用户运行、`/home/user` 归属、读 `/opt/oma/manifest.json`（demo-ok：277 个 dpkg 包、2 个 Python 环境 177 个包、10 个二进制），再销毁。
- **失败路径**：日志末尾是 `[oma] init script failed at line 5: tabulate-cli-that-does-not-exist --version (exit status 127)`，构建记录 `error_code=environment_build_script_failed`，`attempts=1`（脚本失败不重试）。修正脚本后新构建（seq 4）就绪。
- **取代**：v2 的构建在拉 Base Image 时（开始后 47 s），v3 的更新让它变为 `superseded`；日志最后一行是 “A newer change to the Environment superseded this build; its build pod was deleted.”。v3 的构建随即开始；最终镜像的清单 `localBin` 有 `demo-v3`，没有 `demo-v2`。
- **显式 rebuild**：`oma-cli environment rebuild` 对租户环境返回 202 并新建构建（seq 11，定义和 Base Image 都没变）；对内置环境返回 403 `environment_read_only`。

## 3. #303：日志、清单、密钥与权限

- **CLI**：`oma-cli environment get` 返回状态、镜像 digest、清单（8 节：`schemaVersion`、`generatedAt`、`baseImages`、`dpkg`、`pip`、`npm`、`binaries`、`localBin`）和 `lastBuild`；密钥变量只显示 `secretRef`，没有值。`environment logs --follow` 每 2 s 输出增量直到构建结束，`--build-id` 能读任一历史构建（包括失败和被取代的）。
- **控制台**：路由 `/environments/:id`（`web/src/App.tsx`）；`https://agentry-test.welltop.tech/environments/env_video_production` 返回 200。
- **镜像配置与 history 没有密钥**：对 video-production（`54d89827…`）和 demo-ok v3（`fe30f066…`）的镜像配置逐字搜索 `DEMO_SECRET` 的值、`DEMO_SECRET`、`DEMO_PLAIN`、`plain-value`、`sing-box`、`7890`、`proxy`/`PROXY`、`oma-auth`、`auth.json`、`ali-shanghai`、`password`、`Bearer`、`LTAI`、`AKID`，命中 0。`Env` 与 ACS 基础镜像逐项相同；history 只有 RUN 原文和 bind mount 的路径（`/tmp/oma-build.env`）。普通变量也不进镜像：它只在 `build.env` 里，由 bind mount 提供。
- **脚本读不到密钥**：demo-ok 的构建日志打印 `DEMO_PLAIN=plain-value; DEMO_SECRET=unset`。
- **构建 Pod 没有平台密钥**（按 `pod-runner.ts` 的 `buildPodManifest` 渲染的 oma-test Pod）：`automountServiceAccountToken: false`，没有 `envFrom`；env 只有 `OMA_BASE_IMAGE`、`OMA_TARGET_IMAGE`、`OMA_BUILD_NONCE`、`CONTAINERS_STORAGE_CONF`、`BUILDAH_ISOLATION`、`REGISTRY_AUTH_FILE`；卷只有上下文 ConfigMap、推送凭证 `ali-shanghai`（只取 `.dockerconfigjson`，0400）和 emptyDir；非 privileged；`activeDeadlineSeconds: 3900`。推送凭证是 ADR-0024 已接受的风险，不是平台密钥。
- **不依赖集群的测试**：`server/packages/api/test/image-builder.test.ts`（状态流转、60 min 超时、重试、取代、重新领取、停机释放租约、无并发上限）和 `image-builder-builtins.test.ts`、`-pods`、`-context`、`-log`、`-verifier`、`-warm-pool`、`-config`。
- **清单与权限**：`deploy/app/image-builder.yaml` 有自己的 ServiceAccount 和 Role（pods 的 create/delete/get/list/watch、`pods/log` get、configmaps 的 create/delete/list），Warm Pool 的 patch 权限在 `deploy/image-builder-warm-pool-rbac.yaml`。**风险**：Role 允许在自己的命名空间建 Pod；生产上 builder 跑在 `oma-infra`，那里的 Pod 可以挂 `oma-secrets`。本分支随后的评审修复把它记入 ADR-0024 的“Consequences and accepted risks”，补救办法是单独的构建命名空间。

## 4. #305：video-production

**构建**（seq 1，builder 启动时写入内置环境后立即构建）：总计 347.8 s = Pod 启动 47.6 + 拉 `oma-media` 51 + `init.sh`/清单/归属 194 + 推送 30 + 校验 21.0。`init.sh` 的 194 s 包括经 sing-box 下载 630 MB Whisper 模型（vfs-dev 预演里单是模型就用了 75 s）。校验领取 20.7 s，因为池里的 Sandbox 还是 #301 的过渡镜像，换镜像要拉新层。清单：321 个 dpkg 包、4 个 Python 环境 387 个包、15 个二进制。镜像 `welltop/oma-environments@sha256:54d89827f163bc38d8f33026475148b136d128f92c1413aa7d36185f1eab8dd3`，43 层，压缩 1.88 GB。

**Sandbox 内验收**：在 builder Pod 里用部署的 `E2BSandboxClient` 从 Warm Pool 领一个 Sandbox（池已是这个镜像：领取 227 ms，不换镜像），以 `user` 运行，结束后销毁。

| 检查 | 结果 |
|---|---|
| 身份 | `uid=1000(user)`，`HOME=/home/user`，`/home/user` 为 `user:user 755` |
| 线上 `auto-story-smoke`（0.3.3 的副本，最小 PATH，`--require-env`） | 15 项过 13 项。`offline_whisper` 调用没有沿用的旧脚本 `/opt/auto-story/prepare-whisper.py`，推理本身见下一行；`vfs_audio_contract_and_embedded_skills` 被 test 策略拦下（要求 `VFS_PIXEL_DIRECTOR_URL` 为 pre 端点），线上镜像挂同一策略也一样。与 vfs-dev 预演、#301 过渡镜像的结果相同 |
| Whisper 推理（与 story-audio Skill 相同参数，`HF_HUB_OFFLINE=1`） | `base.en`、`small` 都通过 |
| 0.3.1 runtime-overlay smoke | libGL、SceneDetect（第 20 帧切点）、Pillow、fonttools、pip 镜像、NumPy/OpenCV 版本都通过；最后读 `/etc/oma/proxy.env` 失败，这个文件按设计不再生成 |
| 导入（`python`、`python3 -I`） | `cv2` 4.11.0、`scenedetect` 0.7.1、`PIL` 11.3.0、`fontTools` 4.61.1、`numpy` 1.26.4、`google.genai`，`libGL.so.1` 加载成功 |
| vfs-cli 策略文件 | `/etc/vfs-cli` root:root 755；`policy.json` root:root 644，22 字节，`{"environment":"test"}`，sha256 `3af5e4d4…`（与 ConfigMap `vfs-cli-policy-test-v1` 相同）；普通用户追加、改名、新建都是 Permission denied |
| vfs-cli 读策略 | `RUNTIME_ENV=PRO … vfs-cli project query … --force --yes` → exit 2，`environment_policy_conflict`，`policy_environment=test`，`policy_path=/etc/vfs-cli/policy.json` |
| 工具 | ffmpeg 9.0.1、vfs-cli v0.3.21、mediakit-cli 0.2.1、ossutil 2.2.0、node v22.23.2、tini 0.19.0；Pi 0.83.0 七个工具 |
| `/home/user` | 0 个非 user 属主文件 |
| 命令里的代理变量 | 没有：这个 Sandbox 不经 Runner 创建，按命令注入要等新 Runner |

**清单对比**：同一个 `sandbox-inventory.py`，在 vfs-dev 上对推送的 digest 采集（root，`--network none`），与 `fixtures/auto-story-v2-0.3.3-inventory.json` 比较。dpkg 只多 `tini`、`ca-certificates` 小版本更新；5 个 Python 解释器、npm、字体、用户、登录 shell 环境完全相同；ffmpeg、ffprobe、node、rg、fd、vfs-cli、mediakit-cli、ossutil 等二进制 sha256 与线上相同。每一处差异和原因在 [video-production-2026-10-26.md 的“差异”一节](video-production-2026-10-26.md#差异正式镜像相对线上-033)。

## 5. #305：builder 重启与 Base Image 演练

**重复启动**：22:46:48 与 22:48:10 两次 `kubectl rollout restart deploy/oma-image-builder`（rollout 62 s、53 s）。前后 `oma_test` 都是 3 个 Environment（1 个内置）、11 个构建（`max(seq)=11`）、0 个未完成构建；`env_video_production.updated_at` 仍是 04:08:25（+08:00）；新 Pod 的日志只有 `image-builder listening`；SandboxSet 的 generation 仍为 2。04:28:47 和 04:30:09（+08:00）的两次重启同样没有产生构建。

**Base Image digest 演练**：把 builder ConfigMap 的 `BASE_IMAGE_OMA_BASE` 换成作废的 `oma-base-0.1.0`（`007d0b4c…`）并重启（04:32:20 +08:00），再换回 `0.1.2` 并重启（04:36:35）。

| | 重建的 Environment | 构建 | 未重建 |
|---|---|---|---|
| 换到 0.1.0 | demo-ok、demo-fail（都在 `oma-base`） | seq 7、8，都就绪，`base_image_digest=007d0b4c…` | video-production（`oma-media`） |
| 换回 0.1.2 | demo-ok、demo-fail | seq 9、10，都就绪，`base_image_digest=618d3a4f…` | video-production |

- builder 启动日志对每个受影响的环境打一行 `base_image_rebuild environment=<id> base=oma-base digest=<新 digest>`，每个只排一次。
- video-production 全程只有 seq 1 一个构建，镜像、`updated_at` 都没变。
- 演练里两个构建都成功；“一个失败不影响其他”由 `image-builder-builtins.test.ts` 的 “queues every other rebuild when one cannot be queued” 和 “writes the other built-ins when one fails” 覆盖，集群上 seq 3 失败时 demo-ok 也不受影响。
- 演练结束后 ConfigMap 回到 `oma-base-0.1.2@sha256:618d3a4f…`（已核对）。

## 6. Warm Pool 与 ImageCache

- video-production 就绪后，builder 把 `sandbox-system/oma-test-sandbox` 的镜像从 #301 的过渡镜像（`oma-sandbox@sha256:2dd85aa3…`）改成 `oma-environments@sha256:54d89827…`（generation 2）。池模板仍然没有 env 和卷。
- oma-test 设 `WARM_POOL_IMAGE_CACHE=none`，所以 ImageCache 按 #301 的方式手工创建：`aliyun acc create-image-cache`，同一安全组和 3 个 vSwitch，不带镜像凭证，名字取 builder 的命名规则 `oma-test-54d89827f163bc38`（以后打开 `acs` 时 builder 会按名字找到它，不会再建）。`imc-uf60a5qikevuelu3vmjm`：20:16:31 创建，20:20:11 Ready（3 min 40 s），Size 5，标签 `oma.dev/test-only=true`、`oma.dev/issue=305`、`oma.dev/environment=test`、`oma.dev/managed-by=oma-image-builder`。
- 当前池 Pod `oma-test-sandbox-cwcdq` 命中这个缓存（`matched-image-caches`），从创建到主容器启动 28 s。
- 发版顺序（Base Image → builder，等重建的环境就绪 → Runner）写在 `deploy/README.md` 的 “Release order” 和 `deploy/app/image-builder.yaml` 的头注释里。

## 7. 留给新 Runner 的验收

这些需要迁移 0029 和新 Runner（按命令注入变量），本阶段没有做：

- **305-4 代理**：Agent 在 video-production 的 Sandbox 里执行命令时带 `HTTP(S)_PROXY`/`NO_PROXY`；GitHub 经 sing-box，阿里云镜像源和 OSS 内网直连（对照 sing-box 日志里的 Pod IP）。
- **305-5 平台密钥**：一次真实的 MediaKit 调用成功，证明平台密钥按命令到达 Sandbox。
- **#306/#307**：只有有镜像的 Environment 可绑定；按命令的变量传递；span 里带 Environment。
- demo-ok 带普通变量 `DEMO_PLAIN` 和密钥 `DEMO_SECRET`，可以直接用来验证按命令注入；它的租户需要新建 API key。

## 8. 观察到的问题

- **每次构建都完整拉 Base Image**（43–51 s，占普通构建一半）：build 容器的存储是 emptyDir。可以以后用 ImageCache 或节点缓存优化，本阶段不改。
- **校验和 Warm Pool 抢同一个池**：池只有 1 个副本时，同时完成的两个构建里第二个要等新 Sandbox（seq 8、9 的领取 83 s、69 s，不换镜像）。Base Image 变化一次重建很多环境时，校验会按补货速度排队。
- **内置环境失败后无法重建**（代码评审发现）：定义不变时 builder 不重建，内置环境的 rebuild 又是 403。本分支的评审修复改为 builder 启动时重建最近一次构建失败的内置环境。

## 9. 清理与边界

- 构建 Pod 与上下文 ConfigMap：0 个残留（builder 在结束时删除）。
- 测试 Sandbox：只剩池 Pod `oma-test-sandbox-cwcdq`；验收和校验用的 Sandbox 都已销毁。
- 临时 API key `apikey_mjaW8iwQBM1iOP-A7FUQV`：经 `DELETE /v1/api-keys/{id}` 吊销（`revoked_at` 06:52:40 +08:00），之后同一 key 返回 401；本地 key 文件和演示密钥文件已删除。
- 保留：demo-ok、demo-fail（供下一阶段验证按命令注入）、ImageCache `imc-uf60a5qikevuelu3vmjm`、Warm Pool 停在 video-production 的镜像。
- 没有改动 `oma-infra`、`auto-story-v2`、`base-secret`、生产 schema 或 oma-runner；没有应用 0029。vfs-dev 上留有 `oma-environments@sha256:54d89827…` 的本地镜像（采集清单用）。

## 10. 移除 Whisper 后重建 video-production（后续，2026-10-26）

维护者决定从 video-production 去掉离线 Whisper（`/opt/auto-story/whisper-venv` 和 `base.en` / `small` 模型）。提交 `0e165408`（分支 `wt/305-drop-whisper`，基于 `d90942ef`）删除了 `init.sh` 里的 venv、模型两段和自检里的 Whisper 导入，并加了测试保证脚本里不再出现 Whisper。逐项差异见 [video-production-2026-10-26.md](video-production-2026-10-26.md#差异正式镜像相对线上-033)。

**Server 镜像**：在 vfs-dev 的 `~/workspace/yuzhong/oma-env-0e165408`（git bundle，`.buildx-cache` 复制自 `oma-env-d4953e20`）运行 `bash build.sh --push server`，用时 13 s，产出 `oma-server:0e1654082d87` = `sha256:03081cae4cb0b710afa9a80f510128a14db5a279480c61a8d91aa1af4e77ed73`。只有 `sandbox/environments/` 和其后的层是新的；web 没有改动，仍是 `oma-web@sha256:46c36354…`。

**先发 builder**：`render.mjs test` 渲染（api/runner 仍是 `3fbff8c3…`，web `46c36354…`，builder 换成 `03081cae…`），`kubectl diff` 只有 `oma-image-builder` 的镜像一处。04:37:58Z apply，04:39:07Z rollout 完成。新 Pod 启动日志只有一行 `builtin_environment id=env_video_production change=rebuilt`，没有 `base_image_rebuild`；排队的只有 video-production 一个构建（seq 29），10 个迁移副本和其他 Tenant Environment 都没有动。

**构建**（seq 29，`envb_V0KMk31B848HtvytweLW2`，单位 s）：

| | Pod 启动 | 拉 `oma-media` | 构建（`init.sh`/清单/归属） | 推送 | 校验 | 总计 |
|---|---:|---:|---:|---:|---:|---:|
| 这次（无 Whisper） | 24.1 | 46 | 136 | 9 | 8.6 | 227.0 |
| seq 1（带 Whisper，§4） | 47.6 | 51 | 194 | 30 | 21.0 | 347.8 |

- `init.sh` 本身 127 s：apt `libgl1` 84 s、三个 CLI 7 s、Gemini venv 35 s、策略与自检 1 s。少掉的是 Whisper venv 和经 sing-box 下载的 630 MB 模型。apt 比 vfs-dev 预演（23 s）慢，是因为阿里云 Debian 源这次只有 669–762 kB/s（索引 9.4 MB 用 14 s，32 个包 49.6 MB 用 65 s），这一步本次没有改。
- 校验：从 Warm Pool 领到还在旧镜像上的池 Pod，原地换成新镜像，领取 7,040 ms；envd、`user`、`/home/user` 归属检查通过；清单 321 个 dpkg 包、3 个 Python 环境 362 个包、15 个二进制。
- 新镜像 `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:490544134a0313d850ad29eb56ad516a13efd9a23dd469706e3a3a6534fdd111`（标签 `test-env_video_production-envb_V0KMk31B848HtvytweLW2`）。43 层，压缩后 1.100 GB（1,099,503,572 字节），原来是 1.882 GB；Environment 层从 899.7 MB 降到 116.8 MB。

**Warm Pool**：构建结束后 64 ms（04:42:46.77Z），builder 记 `warm_pool_updated pool=oma-test-sandbox image=…@sha256:49054413… previous=…@sha256:54d89827… cache=none`，SandboxSet generation 2 → 3。oma-test 是 `WARM_POOL_IMAGE_CACHE=none`，builder 同时提示 `warm_pool_cold_refill`：补货要完整拉镜像。补货 Pod `oma-test-sandbox-ds965` 04:42:46 创建，拉新镜像约 52 s，04:44:12 就绪（共 86 s）。**没有建 ImageCache**，留给维护者手工配置（命名规则下名字是 `oma-test-490544134a0313d8`）；旧镜像的 `imc-uf60a5qikevuelu3vmjm` 没动。

**清单对比**（seq 29 对 seq 1，两次构建记录里的 `/opt/oma/manifest.json`，逐项求差）：只少了 `/opt/auto-story/whisper-venv` 这个 Python 环境的 25 个包（`faster-whisper` 1.2.1、`ctranslate2` 4.8.2、`onnxruntime` 1.30.0、`av` 18.1.0、`tokenizers` 0.23.2、`huggingface_hub` 1.31.0 等，与原锁文件一致）。dpkg 321 个、Gemini venv、`/opt/venv`、系统 Python、npm、15 个二进制、`/usr/local/bin` 的 sha256、Base Image 记录全部相同，没有新增项。清单不记模型文件，模型在下面的 Sandbox 里检查。

**Sandbox 内验收**：在 builder Pod 里用 `e2b` SDK 从 `oma-test-sandbox` 领一个 Sandbox（`e2b.agents.kruise.io/image` = 新 digest），以 `user`、`cwd=/home/user` 跑检查脚本，结束后销毁（`Sandbox.kill` 返回 true；按标签 `oma.dev/test-only=vp-nowhisper-20261026` 清扫为 0）。这时另一组测试同时在 oma-test 上开了几十个 Session，补货 Pod 已被领走，所以这次是冷启动：领取 90.1 s（`/proc/uptime` 1.33 s），不能代表池里有库存时的领取。

| 检查 | 结果 |
|---|---|
| 身份 | `uid=1000(user)`，`HOME=/home/user`，`/home/user` 下 0 个非 user 属主文件 |
| 导入（`python3 -I`，`python` 包装脚本） | `cv2` 4.11.0、`scenedetect` 0.7.1、`PIL` 11.3.0、`fontTools` 4.61.1、`numpy` 1.26.4、`google.genai`，`libGL.so.1` 加载成功；`import faster_whisper` → `ModuleNotFoundError` |
| 工具 | ffmpeg 9.0.1、vfs-cli v0.3.21、mediakit-cli 0.2.1、ossutil 2.2.0 |
| `/etc/vfs-cli/policy.json` | `{"environment":"test"}`，root:root 644，22 字节，sha256 `3af5e4d4…`；目录 root:root 755；普通用户追加 → Permission denied |
| Whisper | `/opt/auto-story/whisper-venv`、`/opt/auto-story/models`、`auto-story-transcribe`、`prepare-whisper.py`、`whisper-models.json` 都不存在；`/opt`、`/usr/local`、`/home/user`、`/root` 下文件名含 whisper 的 0 个；`/opt/auto-story` 只剩 `venv`（81 MB） |
| 清单 | `/opt/oma/manifest.json` 的 Python 环境是 `/opt/auto-story/venv`、`/opt/venv`、`/usr` |

**再发 API 与 Runner**：等那组测试的 Session 全部结束后（04:52Z），同一镜像 `03081cae…` 渲染，`kubectl diff` 只有 oma-api、oma-runner 两处镜像。04:52:29Z apply，04:54:02Z 全部 rollout 完成，`/api/health` 为 `ok`，新 Pod 日志没有错误。现在 oma-api、oma-runner、oma-image-builder 都是 `oma-server@sha256:03081cae…`，oma-web 仍是 `46c36354…`。

**真实 Session**：一次性 Tenant `vp-nowhisper-1792990175`，临时 API key `apikey_vpnowhisper1792990175`（本地生成，库里只存 sha256）。Agent `openai-codex/gpt-5.6-sol`、开启 Sandbox、不指定 Environment，Session `sess_fz-jSyRy1IBBLcixPM-7C` 的 Environment 是 `env_video_production`。bash 执行 `ffmpeg -version | head -1 && vfs-cli --version && (test -e /opt/auto-story/whisper-venv && echo WHISPER_PRESENT || echo WHISPER_ABSENT)`，输出 `ffmpeg version 9.0.1`、`vfs-cli version v0.3.21`、`WHISPER_ABSENT`。`span.sandbox_prepare_end`：image `…@sha256:49054413…`，`swapped: false`，`claimMs` 81,721（池里没有库存，冷启动并完整拉镜像）。之后删除了 Session 和 Agent，Sandbox 已回收；key 经 `DELETE /v1/api-keys/{id}` 吊销（`revoked_at` 04:56:59Z），再用返回 401，本地 key 文件已删除。

**回滚**（不需要动数据库）：

```bash
export KUBECONFIG=~/.kube/agent-platform-config
# Server 回到 d4953e20 的镜像；builder 启动时看到定义变回带 Whisper 的版本，会重建 video-production
# （新 digest，内容等同 54d89827…）并把池子换过去。
node deploy/scripts/render.mjs test sha256:3fbff8c3fa6a2e668a1f78b71d1f472f1486cf0f205bd0c7f720316fb9316566 \
  sha256:3fbff8c3fa6a2e668a1f78b71d1f472f1486cf0f205bd0c7f720316fb9316566 \
  sha256:46c363546a121bb75b612ba2a0a33249a03964d9f929838215df29c0b3119f8d \
  sha256:3fbff8c3fa6a2e668a1f78b71d1f472f1486cf0f205bd0c7f720316fb9316566 > /tmp/oma-test.yaml
kubectl diff -f /tmp/oma-test.yaml; kubectl apply -f /tmp/oma-test.yaml
```

带 Whisper 的旧镜像 `oma-environments@sha256:54d89827f163bc38d8f33026475148b136d128f92c1413aa7d36185f1eab8dd3` 和它的 ImageCache `imc-uf60a5qikevuelu3vmjm` 都还在；回滚后重建出的镜像内容与它相同，digest 不同。

**留给维护者**：

- **ImageCache**：新 digest `sha256:490544134a0313d850ad29eb56ad516a13efd9a23dd469706e3a3a6534fdd111` 还没有缓存，池子补货和冷启动都要完整拉 1.1 GB（这次 52 s 拉取，补货共 86 s，冷启动领取 82–90 s）。
- **还带 Whisper 的副本**：Tenant Environment 不随内置定义变化，它们的脚本仍是原来的（`init_script` 含 Whisper）。迁移 0029 建的 10 个按 Agent 副本（`env_agent_*`，7 个在 Tenant `f00c7d5a-…`，3 个在 `reconcile-*` 测试 Tenant），另有 4 个手工复制的（`video-production-copy`、`video-production-copy-2`、`finalcut-group-b-20261026`、`accept-figlet-1792978750`）。没有改动它们。要更新，可以由各 Tenant 对副本调用 `POST /v1/environments/{id}`，写入新的 `initScript`（迁移副本可直接用内置的新脚本；手工改过的副本要保留各自追加的部分），保存会排一次新构建；如果它们只是测试用的，也可以直接删掉。生产还没有应用 0026/0029，没有这类副本。
- **vfs-dev**：#305 清点时拉下的 `oma-environments@sha256:54d89827…`（6.56 GB）已删除，其他镜像没动。构建目录 `~/workspace/yuzhong/oma-env-0e165408` 保留。
- **同时在跑的测试**：这次 builder 重启时，另一组测试（Tenant `f00c7d5a-…`，`env-review-…-A`/`-B`）有一个构建正在进行（seq 27），它被新 Pod 重新领取（`attempt=2 reclaimed=true`），04:40:20Z 成功。API/Runner 是等那组测试的 Session 都结束后才发的。
