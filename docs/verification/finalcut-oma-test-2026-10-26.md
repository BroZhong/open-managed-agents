# Environments 最终 oma-test 发布与 Finalcut 回归（#312）

2026-10-26（Asia/Shanghai；带 Z 的时间为 UTC）。集成分支 `docs/adr-0024-environments` 的 `d4953e20` 按发版顺序发布到 oma-test，再用 Finalcut（AutoShort 第 6 步，EP23）跑两组回归。只改动了 `oma-test` 命名空间、`oma_test` schema 和测试 Tenant 的 Workspace 前缀；生产只读。逐项数据见 [JSON 证据](finalcut-oma-test-2026-10-26.json)。

**结论：全部验收项通过。**

1. **发布**：Base Image 不变 → 迁移 0030 只应用到 `oma_test` → vfs-dev 构建 `oma-server@sha256:3fbff8c3…`（web 不变）→ 先发 oma-image-builder，就绪后没有排任何重建、Warm Pool 不变 → 再发 oma-api、oma-runner（oma-web 镜像不变）。回滚目标是 5abd8031 的镜像和 0030 的回滚 SQL（§1）。
2. **组 A（video-production）**：487 s；**组 B（复制 video-production 加一行 `/etc/profile.d` 的 Tenant Environment，构建 733 s）**：583 s。两组都只有 1 个 `turn_completed`、0 个 `session.error`；`final.mp4` 都是 480×854（A 87.8 s、B 88.2 s），本机 ffmpeg 完整解码无错误；字幕报告 `geometry_pass: true`、Skill 默认样式；没有 pip/apt/npm 安装；MediaKit ASR 调用全部成功；没有任何 vfs-cli 命令、`resource create`/`asset create`、上传或发布。
3. **耗时**：两组都远低于 30 min，也低于对照（生产 123 例中完成 119 例，中位 1130 s）；对照是 231 个 Session 并发时测的，两组单独运行，只能说明没有变慢。
4. **领取**：A 不换镜像 `claimMs=606`；B 原地换镜像 `claimMs=23250`（Tenant 副本的 Environment 层要整层拉取，§5）。span 与绑定行都带 Environment 和镜像 digest。
5. 临时 API key 已吊销（再用 401），两个 Session 的 Sandbox 已回收。没有发现需要改代码的问题。

## 1. 发布

| 步骤 | 时间 | 结果 |
|---|---|---|
| Base Image | — | 不变：`oma-base-0.1.2`（`618d3a4f…`）、`oma-media-0.1.2`（`9a57f901…`） |
| 构建镜像 | 03:04:19–03:04:34Z | vfs-dev `~/workspace/yuzhong/oma-env-d4953e20`（git bundle），从 `oma-env-5abd8031` 复制 `.buildx-cache`，`bash build.sh --push server web`，15.6 s（依赖层全部 CACHED，只重做源码层） |
| 迁移 0030 | 03:05Z（builder 发布前） | `migration-for-env.mjs test` 改写后经 Supabase MCP `execute_sql` 执行（去掉 `BEGIN;`/`COMMIT;`，保留 `lock_timeout`）。`oma_test.environment_builds.retries` integer NOT NULL DEFAULT 0，`oma_test_app` 可 SELECT/UPDATE；25 个已有构建都为 0；`oma` schema 没有这一列 |
| oma-image-builder | apply 03:18:16Z → Ready 03:19:31Z | 见下文 |
| oma-api / oma-runner / oma-web | apply 03:21:22Z → 全部 rollout 03:23:06Z | `/api/health` = `{"status":"ok"}`，新 Pod 日志无错误 |

| Deployment | 发布前（回滚目标） | 发布后 |
|---|---|---|
| oma-api、oma-runner | `oma-server@sha256:298ec946812be754666b2c264f49a90d713c255225fdb1dbd1d5db617b5db3f0`（5abd8031） | `oma-server@sha256:3fbff8c3fa6a2e668a1f78b71d1f472f1486cf0f205bd0c7f720316fb9316566`（tag `d4953e205c2e`） |
| oma-image-builder | `oma-server@sha256:61e257409a100d8fcf1b479fc0bb5ef2cbf9fcaad7bec3f4b0c1ded614270a02`（017d2b18） | 同上 `3fbff8c3…` |
| oma-web | `oma-web@sha256:46c363546a121bb75b612ba2a0a33249a03964d9f929838215df29c0b3119f8d` | 不变（5abd8031 之后 `web/` 没有改动，重新构建得到同一 digest） |

- **`kubectl diff`**：先只换 builder（其余三个镜像保持原值渲染），diff 只有 `oma-image-builder` 的镜像一行；再渲染全部新镜像，diff 只有 `oma-api`、`oma-runner` 的镜像各一行。5abd8031 之后的清单改动只有 `deploy/app/image-builder.yaml` 的注释。apply builder 时 kubectl 对 `oma-runner` 也报了 `configured`（只是 last-applied 注解），Runner 的 ReplicaSet 和 Pod 都没有变。
- **builder 先行，没有排任何重建**：发布前 `oma_test` 有 25 个构建、0 个未完成（发布前有两个构建在跑：测试 Tenant 里有人在 10:52、10:56（+08:00）用 `from` 复制了两个 `video-production-copy*`，等它们 11:12、11:15 成功后才发布 builder，没有打断）。新 builder：apply 后旧 Pod 先退出（`Recreate`），新 Pod 03:18:35Z 创建、03:19:17Z 容器启动、03:19:25Z `image-builder listening`、03:19:31Z Ready，即 apply 到就绪 75 s，容器启动到监听 8 s。到 03:24:32Z 创建组 B 的 Environment 之前，日志里没有 `base_image_rebuild`，也没有 `environment_build_start`；发布后 `environment_builds` 仍是 25 行、`max(seq)=25`、0 个未完成；`env_video_production` 的 `updated_at`（04:08:25 +08:00）和 `last_build_id` 不变；Warm Pool `oma-test-sandbox` 的 generation 仍为 2、镜像仍是 `oma-environments@sha256:54d89827…`。
- 启动日志有一条 pg 的 `DeprecationWarning: Calling client.query() when the client is already executing a query`；发布前的 API 和 Runner（5abd8031）日志里也各有一条，不是这次引入的。

**回滚**（按 [environments-runtime-oma-test-2026-10-26.md](environments-runtime-oma-test-2026-10-26.md) 的做法，只是目标换成 5abd8031 的镜像；本次没有配置改动，所以不需要补回任何项）：

```bash
export KUBECONFIG=~/.kube/agent-platform-config
node deploy/scripts/render.mjs test \
  sha256:298ec946812be754666b2c264f49a90d713c255225fdb1dbd1d5db617b5db3f0 \
  sha256:298ec946812be754666b2c264f49a90d713c255225fdb1dbd1d5db617b5db3f0 \
  sha256:46c363546a121bb75b612ba2a0a33249a03964d9f929838215df29c0b3119f8d \
  sha256:61e257409a100d8fcf1b479fc0bb5ef2cbf9fcaad7bec3f4b0c1ded614270a02 > /tmp/oma-test-rollback.yaml
kubectl diff -f /tmp/oma-test-rollback.yaml; kubectl apply -f /tmp/oma-test-rollback.yaml
# 旧镜像跑起来之后（经 MCP 时去掉 BEGIN/COMMIT）：
node deploy/scripts/migration-for-env.mjs test deploy/migrations/0030_environment_build_retries.rollback.sql
```

再往前回滚到 017d2b18 仍用 `~/oma-311/oma-test-rollback.yaml` 和 0029 的回滚 SQL。

## 2. Finalcut 回归的准备

- **临时 API key**：`apikey_cb9HjQBBUiKt5inNL_xX2`，测试 Tenant `f00c7d5a-dd14-43e6-b791-e561c192d312`，在 oma-test API Pod 里用 `PgApiKeyStore`（`search_path=oma_test`）创建；原始 key 只在该 Pod 的 0600 文件里，没有打印。驱动脚本拒绝 `PG_SCHEMA≠oma_test`，只访问 `https://agentry-test.welltop.tech/api`。
- **Finalcut Agent** `agent_BE4F7mWvPvtAPIaVtjKPK`（`finalcut-oma-test-20261026`）：`POST /v1/agents/agent_M794Gt4iPwX-ZblaA_lW2/fork`，再改 `thinking: high`、`environmentId: env_video_production`，system 末尾追加一段约束（原文 403 字符 → 795 字符）。模型 `deepseek/deepseek-flash` 不变；19 个 Skill 是 fork 的副本，名字与 bundle sha256 和源 Agent 逐个相同。其中 Finalcut 用到的 `precise-subtitles`（`d723ffb7`）、`scene-cut-intro`（`dd347478`）和 5 个 `byted-mediakit-*` 与生产对照 Agent `agent_XsS1yQXmJS212Ag7SsmTk` 的 bundle 也相同；生产对照同为 deepseek-flash、thinking high。
- **追加的约束**（要点）：禁止任何会创建、修改、删除、绑定、上传、发布或上报的 vfs-cli 命令（点名 `vfs-cli resource create`、`vfs-cli asset create`）和任何 VFS 写接口，禁止上传或发布文件、资源、资产；输出只写用户指定的 `outputs/regression-finalcut/`；按要求剪辑出 `final.mp4` 不算原 system 里禁止的“生成图片视频”（原 system 写的是“所有文件只写 outputs/run-NNN”“不要生成图片视频”，与 Finalcut 任务冲突，所以加了这一句澄清）；约束传给子 Agent。
- **输入**：生产 Session `sess_aXqzfulooKU5gjvszDfX1` 跑在 `ws_srjiyo7gc2Js_xutZ3TWq`，那是 10-25 回归从 `tw_b4293796…` 复制出来的 Workspace。两边只读列出（`listV2`）：`tw_b4293796…` 共 12,468 个对象，其中 EP23 有 464 个；按回归脚本的过滤（`inputs/EP23/episode-script.md`、`outputs/EP23/storyboard-dp.csv`、`outputs/EP23/video_generation.md`、`outputs/EP23/_work/finalcut/src/*`）正好 18 个、42,582,669 B。`ws_srjiyo7gc2Js…` 的 EP23 对象就是这 18 个（etag 逐个相同），其余 513 个是那次回归的输出（`outputs/regression-finalcut/`）。所以从 `tw_b4293796…` 只复制这 18 个输入，不复制任何输出。
- **两个测试 Workspace**：两组都写 `outputs/regression-finalcut/`，所以各建一个：A `ws_dQ96XGT-4f04oSRiGW5b-`、B `ws_Wjiiy3JMl_dhQ9a4J9NSe`（`POST /v1/workspaces`）。用 OSS 服务端复制（源只读、目标是测试 Tenant 前缀 `f00c7d5a…/<ws>/`），复制后列出目标：各 18 个、42,582,669 B，etag 与源逐个相同（03:24:37Z、03:24:39Z）。
- **Prompt**：从生产 `oma.events` 只读取出 `sess_aXqzfulooKU5gjvszDfX1` 的第 1 条 `user.message`，原文照用。它只写 Workspace 内的相对路径，没有点名生产 Workspace，所以不需要改。

## 3. 组 B 的 Environment

`finalcut-group-b-20261026`（`env_VnioXyHxyuHUwS2FCCeYx`）：`POST /v1/environments`，`from: env_video_production`，`initScript` = video-production 的脚本（11,873 字符）末尾加两行（共 12,048 字符）：

```bash
# #312 group B: a small addition to the copied video-production script
printf 'export OMA_FINALCUT_GROUP="${OMA_FINALCUT_GROUP:-B}"\n' > /etc/profile.d/oma-finalcut-group.sh
```

25 个变量随复制带过来（6 个代理变量 + 19 个 `secretRef.source=platform`，含 `MEDIAKIT_API_KEY`），Base Image `oma-media`。

| 阶段（build `envb_L5R2ZrcBCwcZgpvaIfWAJ`，seq 26） | 时间 | 用时 |
|---|---|---|
| 创建 → builder 领取 | 03:24:32.754Z → 03:24:35.587Z | 2.8 s |
| 领取 → 构建 Pod 开始拉 Base Image | → 03:25:03Z | 27.4 s |
| 拉 `oma-media` | → 03:25:51Z | 48 s |
| init 脚本、清单、`/home/user` 归属（日志 `Built in 590 s`） | → 03:35:41Z | 590 s |
| 推送 | → 03:36:24Z | 40 s（日志 `Pushed … in 40 s`） |
| 校验：从 Warm Pool 领一个 Sandbox 原地换镜像 | 03:36:24.456Z → 03:36:45.722Z | 21.3 s（领取 21,040 ms，swapped） |
| **总计（创建 → ready）** | → 03:36:45.853Z | **733 s（12 min 13 s）** |

- 结果 `oma-environments@sha256:9d65087fd3f3998ef55e42c2bbba4a3898e5a892b45ba19423821cf106c5bbae`；清单 321 个 dpkg 包、4 个 Python 环境 387 个包、15 个二进制，与 video-production 相同。`attempts=1`、`retries=0`。
- init 脚本这次用了 590 s，而 video-production 单独构建时是 194 s（[environments-oma-test-2026-10-26.md](environments-oma-test-2026-10-26.md) §4）。同一天测试 Tenant 里另外两个原样复制（seq 24、25，并发）各用了 20 min 16 s、19 min 11 s，所以慢在脚本的下载（pip 镜像与经 sing-box 的 Whisper 模型），不是这一行；日志没有逐行时间戳，没法再细分。
- 在 vfs-dev 拉取这个 digest 核对（`--network none`）：`/etc/profile.d/oma-finalcut-group.sh` 存在（root 0644，53 B）；`su - user` 的登录 shell 得到 `OMA_FINALCUT_GROUP=B`；命令自带 `OMA_FINALCUT_GROUP=X` 时得到 `X`，即 `${VAR:-默认值}` 约定生效。核对完删掉了本地镜像。

## 4. 两组的运行与验收

| | 组 A | 组 B |
|---|---|---|
| Session | `sess_S890CalbNp52PGul4ZKTx`（Workspace A） | `sess_XdBHpB3HiAc3rTto3VXW2`（Workspace B，创建 Session 时 `environmentId` 指向组 B 的 Environment） |
| Session API `environment` | `{id: env_video_production, name: video-production}` | `{id: env_VnioXyHxyuHUwS2FCCeYx, name: finalcut-group-b-20261026}` |
| 发消息 → `turn_completed` | 03:24:52.842Z → 03:33:00.257Z | 03:40:16.905Z → 03:50:00.319Z |
| **单组耗时** | **487 s（8 min 7 s）** | **583 s（9 min 43 s）** |
| `turn_completed` / `session.error` / `turn_resumed` | 1 / 0 / 0 | 1 / 0 / 0 |
| 工具调用 / 结果 | 64 / 64（bash 49、read 11、write 4），每个调用恰好一个结果 | 63 / 63（bash 56、read 4、write 2、edit 1），每个调用恰好一个结果 |
| `isError` 的工具结果 | 1：Agent 自己写的解析脚本 `KeyError: 'result'`，下一条改正 | 1：Agent 自己的 heredoc Python `SyntaxError`，下一条改正 |
| 子 Agent | 0 | 0 |
| pip / apt / npm 安装 | 0 | 0 |
| vfs-cli | 0 次调用 | 只有一次 `which mediakit-cli vfs-cli`，没有执行任何 vfs-cli 命令 |
| `resource create` / `asset create` / 上传 / 发布 | 0 | 0 |
| 其他外部访问 | 没有 curl、wget、ossutil 或 HTTP 调用 | 同左 |
| MediaKit | `video asr-subtitles` 1 次（`success: true`）+ `shared query-task --poll-complete` 1 次，得到逐句时间戳 | `video asr-subtitles` 2 次（对两个版本的拼接母版各 1 次，都 `success: true`）+ `query-task` 2 次，都完成（87.38 s、27 句） |
| `final.mp4` | 480×854，24 fps，2108 帧，87.833 s，H.264 High + AAC，15,407,243 B，sha256 `506de252…` | 480×854，24 fps，2117 帧，88.208 s，H.264 High + AAC，15,610,050 B，sha256 `b60f1ec8…` |
| 完整解码（下载后本机 `ffmpeg -v error -i final.mp4 -f null -`，FFmpeg 7.1.1） | exit 0，stderr 0 字节 | exit 0，stderr 0 字节 |
| 字幕报告 | `subs/report.json`：`geometry_pass: true`，28 条，Skill 默认样式（font 34 / baseline 35 / bottom 122 / side 26 / max_width 428 / stroke 2 / 2 行），ASS 字号 37.984375，后端 ffmpeg-libass 9.0.1 | `subtitles_render/report.json`：`geometry_pass: true`，28 条，同一套默认样式与 ASS 字号 |
| Sandbox | `oma-test-sandbox-47xkd`，镜像 `…@sha256:54d89827…`，restartCount 0 | `oma-test-sandbox-b27dl`，镜像 `…@sha256:9d65087f…`，restartCount 1（原地换镜像） |

- 监控方式：运行期间每 1–2.5 min 只读查询 `oma_test.events` 里两组（及其子 Session）的全部 `toolCall`，用正则标记 vfs-cli 写命令、`asset|resource create`、ossutil 写、pip/apt/npm/conda/dpkg 安装；结束后再对全部调用做一遍，并单独列出含 `curl|wget|http|ossutil|vfs|upload|publish|pip|apt|npm` 的调用逐条看过。两组都没有触发中止条件。
- Agent 在 `result.json` 里自报 `vfs_writes: 0`、`publishes: 0`、`uploads: 0`；上面的结论来自事件，不依赖自报。
- 组 B 的 MediaKit 返回里带一条 `_notice`：“skills are not synced with current CLI … run: mediakit-cli update --force”。Agent 没有执行 update，任务正常完成。组 A 的返回里没有这条；两组命令行里的 `MEDIAKIT_RUNTIME` 不同（`pi`、`pi-agent`），原因没有再查。
- 两组的字幕报告 `status` 都是 `rendered_needs_visual_review`，这是 precise-subtitles 编码成功后的固定状态；两个 Agent 都另外抽帧做了目检。

## 5. 与对照比较；领取、换镜像与 span

**对照**（生产，没有重跑，只读取）：`sess_aXqzfulooKU5gjvszDfX1`（Agent `agent_XsS1yQXmJS212Ag7SsmTk`，deepseek-flash、thinking high，`auto-story-v2`）的 `result.json`：`final.mp4` 480×854、88.208 s、2117 帧、28 条字幕、`geometry_pass: true`、同一套默认样式；这个 Session 自身 545 s（中间一次 `turn_resumed`）。10-25 并发回归里 Finalcut 共 123 例，完成 119 例，耗时 min 470 s / **中位 1130 s** / p95 1736 s / max 1913 s（10-25 回归驱动脚本在本机生成的 `/private/tmp/oma-prod-regression-20261025/final-summary.json`，字段 `completedBusinessRuntimeSeconds.finalcut`）。

| | 耗时 | 相对对照中位 1130 s | `final.mp4` |
|---|---:|---:|---|
| 组 A（video-production） | 487 s | −643 s（为中位的 43%） | 87.833 s |
| 组 B（Tenant Environment） | 583 s | −547 s（为中位的 52%） | 88.208 s |
| 对照单个 Session | 545 s | — | 88.208 s |

- 两组都远低于 30 min，也都低于对照中位；但对照中位是 231 个 Session 同时运行时测的，两组是各自单独运行，所以只能说明没有变慢，不能说明变快了。与对照的单个 Session（545 s）相比，A 快 58 s、B 慢 38 s，在单次运行的波动范围内。
- 时长差异不在片头：两组都按 scene-cut-intro 的固定参数在 0.750 s 处剪掉第 1 镜（检测到的场景与对照逐个相同，g1 剩 4.306 s / 103 帧）。差在拼接：A 用 concat 滤镜把每段音频裁到视频帧长，得到 14 段视频帧之和 2108 帧 / 87.833 s；B 和对照保留各段原有的音频长度，得到 2117 帧 / 88.208 s。这是 Agent 选的拼接方式，不是平台差异；两者都约 88 s。

| span | 组 A | 组 B | builder 校验（组 B 的构建） |
|---|---|---|---|
| `sandbox_prepare_start` | 03:24:58.271Z，`environmentId=env_video_production`，image `…54d89827…` | 03:40:22.312Z，`environmentId=env_VnioXyHxyuHUwS2FCCeYx`，image `…9d65087f…` | — |
| `sandbox_prepare_end` | `outcome=ready`，`swapped=false`，**`claimMs=606`**，`durationMs=1011` | `outcome=ready`，`swapped=true`，**`claimMs=23250`**，`durationMs=23650` | 领取 21,040 ms，swapped |
| `skills_install_end` | 19 个、1,978,398 B，989 ms | 19 个、同一 setHash，1,154 ms | — |
| 绑定行 `delegation_environments` | `environment_id=env_video_production`，image 同上 | `environment_id=env_VnioXyHxyuHUwS2FCCeYx`，image 同上 | — |

- 组 A 领到的是池里预热的 video-production 镜像，不换镜像（0.6 s）；组 B 是原地换镜像（23.3 s），与 [environments-runtime-oma-test-2026-10-26.md](environments-runtime-oma-test-2026-10-26.md) 两次换镜像的 24.5 s 一致。组 B 开始前池里有一个空闲副本（`b27dl`，就绪 3 min 43 s），所以这是热 Pod 上的换镜像，不是冷启动。
- **换镜像为什么要 23 s**：组 B 只比 video-production 多一行脚本，但整个 init 脚本是一个 `RUN`，每次构建都产出新的 Environment 层（同一脚本在 #301 过渡镜像里是 856 MB，主要是 Whisper 模型与 venv），领取时要整层拉取。复制 video-production 再小改的 Tenant Environment，每个 Session 首次领取都要付这 20 多秒；ADR-0024 已接受“只拉 Base Image 之上的层”，这里记下实际代价。

## 6. 观察到的问题

- **Tenant 副本领取要换整层**：见上一节，组 B 首次领取 23.3 s（A 0.6 s）。对 Finalcut 这类 8–10 min 的任务影响小；短任务如果常用 video-production 的副本，可以考虑以后把 video-production 的脚本拆成多层或让副本复用父镜像（不在本次范围）。
- **复制 video-production 的构建比单独构建慢**：本次 733 s，其中脚本 590 s；同日两次并发复制约 20 min。都成功，ADR 没有对构建时长的要求，记录供参考。
- **pg `DeprecationWarning`**（同一个 client 上并发 query）：三个角色启动时各一条，5abd8031 已有，不是本次引入；以后升级 pg@9 前要处理。
- **builder 单独 apply 时 kubectl 报 `oma-runner configured`**：只是 last-applied 注解变化，Runner 没有滚动。
- 两组各有 1 个 `isError` 工具结果，都是 Agent 自己写的临时脚本出错并在下一步改正，不是平台或 Sandbox 问题。没有发现需要改代码的问题，本次没有代码改动。

## 7. 清理与边界

- 两个 Session 都已终止（`DELETE /v1/sessions/{id}`），45 s 后它们的 Sandbox `47xkd`、`b27dl` 都已删除；builder 校验用的 `w4w6j` 由 builder 自己销毁。之后 `sandbox-system` 里属于 oma-test 的只剩池里的预热副本（1 个）。同时存在的测试 Sandbox 最多 3 个（组 A、池副本、builder 校验），外加组 B 构建的 1 个 4 vCPU 构建 Pod。
- 临时 API key `apikey_cb9HjQBBUiKt5inNL_xX2` 经 `DELETE /v1/api-keys/{id}` 吊销（200，`revoked_at` 03:53:16Z），再用它请求返回 **401**；API Pod 里的 key 文件和驱动目录已删除。
- 留在 `oma_test`：Finalcut Agent `agent_BE4F7mWvPvtAPIaVtjKPK`（及 fork 出的 19 个 Skill）、Environment `finalcut-group-b-20261026`（镜像在 `welltop/oma-environments`）、两个测试 Workspace（18 个输入加各自的输出：A 的 `outputs/regression-finalcut/` 443 个对象 82.3 MB、B 356 个 54.6 MB，都在测试 Tenant 前缀下）和两个已终止的 Session。测试 Tenant 里别人建的两个 `video-production-copy*` 没有动。
- 生产只读：`oma` schema 只做了 SELECT（`sessions`、`events`、`agents`、`skills`）；OSS 只对两个生产前缀做了 `listV2`、读取了对照的 `result.json`，以及作为服务端复制的源。没有向任何生产前缀写入或删除。
- 没有改动 `oma-infra`、`auto-story-v2`、`base-secret`、生产 schema；`sandbox-system` 只读了本次测试的 Pod 与 `oma-test-sandbox` SandboxSet。vfs-dev 上留有构建目录 `~/workspace/yuzhong/oma-env-d4953e20`，核对用的镜像已删除。
