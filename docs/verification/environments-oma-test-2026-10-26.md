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
