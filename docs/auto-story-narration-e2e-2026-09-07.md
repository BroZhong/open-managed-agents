# auto-story 第一人称故事验收 — 2026-09-07

更新至 2026-09-08。状态：**进行中，尚未完成端到端成片验收**。测试环境已生成真实旁白和参考图，Gemini 同步音频听审已运行。Agent 二进制读取、grep Unicode 和图片历史修复已部署并通过运行时检查；同一 Session 的第三轮已提交，继续看图并制作 14 秒 + 13 秒两段视频。实际看图结果、视频产物、连续原音轨剪辑、成片 Agentic 审片和交付仍待收据确认。工具调用成功不等于内容质量通过。

本报告接续 [基础集成验收](auto-story-e2e-2026-09-07.md) 和 [故事基础设施检查](first-person-story-infrastructure-2026-09-07.md)。它记录本轮已知证据与待补项目，不将早期合成素材通过结果当作真实故事通过结果。只记录非敏感标识和本地/Workspace 路径，不记录凭据或供应商签名 URL。

## 环境、Agent 与原版 Skill

| 项目 | 本轮记录 |
| --- | --- |
| 应用 | `https://agentry.welltop.tech`；Shanghai `agent-platform` / `oma-infra` |
| Agent | [auto-story](https://agentry.welltop.tech/agents/agent_8kC4R3BvbC1FxNRzLOm63)，ID `agent_8kC4R3BvbC1FxNRzLOm63` |
| 故事 Session | [sess_HFJ2dDQcgt3GrsT27Df8B](https://agentry.welltop.tech/sessions/sess_HFJ2dDQcgt3GrsT27Df8B) |
| Pi 主模型 | `openai-codex/gpt-6-astra`，保留用户改选；最高支持思考强度。早期基础验收使用 Sol，属于不同阶段 |
| Sandbox | `auto-story`；本轮镜像 `oma-sandbox:auto-story-0.1.1` |
| VFS 测试地址 | `VFS_PIXEL_DIRECTOR_URL=https://pre-pixel-director.creativefitting.cn`；`VFS_YJS_URL=https://pre-api.welltop.tech` |
| 工作目录 | `/home/user/narration-story/`；Gemini helper 在 `/home/user/auto-story-e2e/` |
| Skill 数量 | 8 个：5 个原版 MediaKit Skill、VFS、video-analysis、narration-led-film |
| 故事 fork | `skill_lUR9el5_YtwYWNkybTcHt`，投影 `/skills/skill_lUR9el5_YtwYWNkybTcHt/SKILL.md` |
| 刷新的 VFS fork | `skill_7hR5_AiyKSLPm16GsW3k6` |

故事 Skill 来源为用户提供的 `/Users/zhangyuzhong/Downloads/短剧生成 0906/skills/narration-led-film/`。装备使用原版目录及 Agent 独立 fork；未将故事 Skill 复制进仓库或镜像，也未为通过验收改写原始 Skill。Gemini helper 是验收脚本，Agent 仍须读取已装备原版 Skill。

Agent 系统段由 [configure-narration.mjs](../deploy/auto-story/configure-narration.mjs) 幂等维护，保留既有主模型和配置。它明确测试路由、实际模型别名、先保存 task ID 再查询、保留供应商原字幕、按真实音轨时间组织画面、连续原音轨剪辑，以及同步 Gemini 听审和显式 Agentic 视频审片。声音为 `seed-audio-1.0`，图片为 `gpt-image2`，视频为 `seedance-2.5`，审片为 `gemini-3.8-flash`；不自动换模型或重发状态未知的收费生成。

## CLI 与 sandbox 0.1.1

VFS CLI **v0.3.14 已发布**，增加 SeedAudio 生成和音频 Resource 注册。本轮与早期使用 v0.3.13 的合成素材验收分开记录。

| 项目 | 证据 |
| --- | --- |
| 镜像 tag | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.1.1` |
| 已发布 digest | `sha256:bdf9bdc74ad8e1f289b3993bb8154e388a505a43c3e24d47cbaae874e5ad49f4` |
| CLI / SDK | `vfs-cli v0.3.14`、`mediakit-cli 0.2.1`、`google-genai 2.22.0` |
| 构建及推送日志 | `/private/tmp/oma-auto-story/sandbox-0.1.1-build.log` |
| CLI 归档 | `/private/tmp/oma-auto-story/v0.3.14/vfs-cli_v0.3.14_linux_amd64.tar.gz` 及同名 `.sha256` |
| 运行实例的不可变镜像核对收据 | pending：补实际 sandbox 实例及 digest 收据 |

构建日志确认以非 root 用户、最小 PATH 完成 Workspace 写入、H.264/AAC 生成、ffprobe、MediaKit 本地元数据、VFS 内置 Skill、音频 schema、音频生成 dry-run、音频 URL/文件 Resource dry-run、Gemini Files/Interactions SDK 检查。额外运行确认环境变量注入标记存在；没有把凭据写进镜像或报告。dry-run 证明 CLI 请求契约，本轮下述真实素材任务提供生成执行证据。

## 工具修复部署收据 — 2026-09-08

| 项目 | 已确认结果 |
| --- | --- |
| 工具源码修复 | `5fe3aa6`：read 二进制读取、grep Unicode 输出和图片历史处理 |
| 部署快照修复 | `c8300f5`：刷新 API 实际导入的 pnpm `file:` 依赖快照 |
| 构建入口 | [Dockerfile.tools](../deploy/auto-story/Dockerfile.tools)，基于已验证的部署镜像保留既有依赖和路由 |
| 镜像 tag | `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server:auto-story-tools-c8300f5` |
| 发布并部署 digest | `sha256:5a83e4f5eba8a4739d617186d167101fae08743323e1538f8922896055cc7509` |
| 更新的容器 | `server` 与 `seed-pi-auth` 均使用同一 digest，rollout 成功 |
| 新 Pod | `oma-server-7ffb98767f-624rv` |
| 实际运行时验证 | API 解析的 Pi adapter 导入路径中，`custom-tools.ts`、`translator.ts` 的 SHA-256 均与源文件匹配；模块 import 成功；health 返回正常 |
| 本地验证 | Pi 包完整 118 项测试与 TypeScript 检查通过 |
| 工作流续跑 | 原 Session 第三轮已提交：先确认参考图，再执行 14 秒 + 13 秒两视频阶段；完成结果 pending |

仅覆盖 `/app/adapter` 源码不足以保证 API 使用新代码：pnpm 的 `file:` 依赖是独立快照。部署镜像必须同时刷新 API 实际解析的依赖目录，并从该运行目录验证解析路径、文件哈希和模块 import。此收据确认修复已进入运行时；实际参考图内容检查与视频生成结果继续单独验收。

## 故事输入与一期范围

本轮使用 [narration-brief.md](../deploy/auto-story/e2e/narration-brief.md) 中的原创虚构中文第一人称故事：成年女性搬离住了十年的老巷，雨夜亮起的门灯和邻居挥手让她感到被惦记。目标约 25–30 秒、16:9、写实温暖风格，声音包含连续旁白、轻雨声和稀疏钢琴，人物不对画外音做现场口型。

一期只允许一次 SeedAudio 和一次 GPT Image 2 生成，提交后保存 task ID 并查询原任务。后续视频阶段使用同一 Session 和已有素材，不因客户端或工具失败重复生成。各阶段调用次数最终清单：pending。

## 真实素材与音频审听

| 项目 | 已知结果 |
| --- | --- |
| 音频任务 | `audio_4494b425-909e-49e6-8944-280cca0d3d28` |
| 音频 Resource | `103932` |
| 原始主音轨 | `/home/user/narration-story/master.wav`，实测 27 秒 |
| 音频 SHA-256 | `c5268033cf16af69e602a885235ffa4358c9b237cdc324a98ca5098510ce48a7` |
| 供应商原字幕 | `/home/user/narration-story/subtitles/provider-original.json`；末字结束于 25.760 秒，27 秒音轨保留 1.240 秒尾音。完整句/词时间表的报告汇总：pending |
| Gemini 独立转录 | `/home/user/narration-story/reviews/gemini-audio-sync.transcript.md` |
| Gemini 实际听审 | `/home/user/narration-story/reviews/gemini-audio-sync.md` 及 `gemini-audio-sync.evidence.json` |
| 补充声音审查 | `/home/user/narration-story/reviews/gemini-sound-audit.md` 及 `gemini-sound-audit.evidence.json` |
| 图片任务 | `06514068-eda6-492d-b328-3f5257041efb` |
| 图片 Resource | `103933` |
| 参考图 | `/home/user/narration-story/reference.png`，2048 × 1152 |
| 图片 SHA-256 | `f1ceeb642e8158de235dd62b303c0dea0432dcc15fcaefbed883440d09a6931a` |

实际音轨通过 Gemini `gemini-3.8-flash` 同步 Interactions 完成独立转录；外部诊断转录与原稿一致，随后 Session 保存了完整听审文件。请求使用实际上传音频及 `audio/wav`，`background=False`、`store=False`；完成但无 interaction ID 是此路线的正常结果。独立转录请求不包含原稿，第二次请求重新提交实际音频并带上原稿与独立转录进行比对。

**音频内容质量尚不能整体标为通过。** 两次声音审查对音乐起点、雨声存在矛盾意见；需要结合真实音轨和原始字幕复核并明确采纳哪条观察，不能把不一致的模型意见都记成事实。25.760 秒是已读出的供应商字幕末字时间，不能用 Gemini 估算时间戳替代精确剪辑边界。

参考图已经生成并落盘；此前 Agent 读取 PNG 二进制时发生工具错误。修复已部署，原 Session 第三轮已续跑看图，人物/画面内容的检查结果仍待收据。`phase1.json` 和 `phase1-review.md` 曾因该中断未写完，本次续跑是否补齐仍为 pending，不能当成已存在的交付收据。

## 已定位的通路问题

| 问题 | 处理与当前状态 |
| --- | --- |
| 音频 background 返回 400 | 真实原因是对应后台模型路线未启用音频输入。保持 Gemini 3.8 Flash，改同步 Interactions；将 `audio/x-wav` 规范为 `audio/wav`。实际同步转录成功 |
| SDK 错误状态未识别 | Interactions 使用 `status_code`，Files 常用 `code`；helper 现在兼容两者，并只输出脱敏 `provider_reason`。明确 create 拒绝可清理；已提交任务的 get/cancel 400 不视作任务结束 |
| 扫描 SDK 的 Unicode 工具错误 | Session 曾因此中断；grep Unicode 修复已随 `5fe3aa6` / `c8300f5` 镜像部署，Pi 测试及运行时模块验证通过 |
| 参考图二进制读取与图片历史 | 修复已部署；原 Session 第三轮已续跑。实际看图结果和一期 checkpoint：pending |

音频第一次明确被 400 拒绝后遗留的 `files/k27zws8hdx88` 已列入 Session 清理指令；最终删除收据：pending。后续 helper 运行是否全部 `upload_deleted=true` 需汇总各 evidence，不能仅凭新的默认配置推断旧上传已删除。

## Agentic canary：运行成功与内容错误分别记录

在真实最终视频之前，使用已有三秒 canary 检查显式 `processing:"agentic"`。源文件为 `/private/tmp/auto-story-e2e-verified/canary.mp4`，SHA-256 `e07aa14716c82bcf205b2ddbe5e3bd49252f365917194b936b36521ca4cfa2ba`，画面为红底白色矩形，音频为连续 440 Hz 音调。

同步请求返回 `completed`、模型 `gemini-3.8-flash`、两组非空且严格匹配的 `processing_call.id` / `processing_result.call_id`，并确认上传删除。此结果证明原生 Agentic 处理路线执行成功，**不证明分析内容正确**：Gemini 把纯音调误判成一段关于 AI 摘要的英文人声。这是有明确输入对照的音频幻觉，不能用作实际旁白审听或成片质量通过依据。

对应后台请求先返回 `in_progress`，之后 get/cancel 都报 HTTP 400 `Unsupported file uri`。额外 `get(include_input=False, timeout=20)` 仍返回 400 `Request contains an invalid argument.`。后续流式 GET 仅收到 `interaction.created`（`in_progress`）、状态更新与 error，没有可确认的终态。故障 canary 上传 `files/goldpw4eaamn` 继续保留，`cleanup_pending=true`。流结束或删除 interaction 记录均不等于取消运行，本报告不将其视为清理成功。

诊断收据均在 `/private/tmp/oma-auto-story/`：

- `agentic-canary-sync.evidence.json`、`agentic-canary-sync-result.json`、`agentic-canary-sync.md`：同步执行、配对、清理及实际错误回答。
- `agentic-canary.evidence.json`、`agentic-canary-result.json`：后台提交与 get/cancel 失败。
- `agentic-canary-cleanup-check.json`：显式排除输入后的只读查询仍失败。
- `agentic-canary-cleanup-stream.json`：流式读取有创建、状态更新与错误事件，没有确认终态。

视频 helper 的 `--execution auto` 已改为同步，保留显式 background，不自动切换路线或模型。

## 验证与待补验收

截至本次记录，18 项离线 helper 测试、CLI help 与 `git diff --check` 通过。测试包含真实 google-genai 2.22.0 类型和错误对象、实际媒体输入契约、转录与原稿隔离、MIME 规范、同步无 ID 响应、Agentic 配对、取消与清理、后台 get/cancel 400 时保留上传。离线测试不产生供应商费用，也不替代真实故事验收。

| 待完成项 | 验收依据 |
| --- | --- |
| 验收修复后的参考图读取 | 修复部署已完成；等待第三轮实际查看 PNG 的结果，记录画面与提示词的符合/不符合项 |
| 保存一期 checkpoint | `/home/user/narration-story/phase1.json`、`phase1-review.md`，包含实际素材、模型、任务/资源 ID、字幕路径和声音争议 |
| 核对声音内容 | 原稿、独立转录、真实听音和供应商字幕共同复核；对雨声/音乐冲突给出可追溯结论 |
| 根据实际声音划分视频 | 第三轮按 14 秒 + 13 秒推进；对应音频切片 Resource 与实际生成请求收据：pending |
| Seedance 2.5 视频生成 | 第三轮已提交继续指令；实际任务/Resource/素材文件、音频引用及次数：pending |
| 连续原音轨剪辑 | 时间线、移除生成视频伴生音频、保留主音轨、最终 MP4：pending |
| 最终成片 Agentic 审片 | 实际成片输入、严格配对、观察与内容问题、修正/复审：pending |
| 最终媒体播放与交付 | 可播放 MP4、完整素材/字幕/时间线/审片记录及准确结论：pending |
| 清理收尾 | 故障后台 canary 的可靠终态/上传处置，以及其他测试上传删除收据：pending |

最终结论：pending。只在真实成片、Agent 工具执行证据和内容复核都完成后更新；不以 canary 调用成功或 Resource 生成成功替代完整故事通过。
