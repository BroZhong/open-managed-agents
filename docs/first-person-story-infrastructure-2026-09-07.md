# 第一人称故事短片基础设施审计

审计日期：2026-09-07。目标：agentry.welltop.tech 上的 auto-story。

本文保留授权部署前的审计状态。后续测试环境配置、v0.3.14 发布及真实故事验收进展见 [故事验收记录](auto-story-narration-e2e-2026-09-07.md)。

本次按用户要求评估缺口。附件中的制作指令作为需求材料；没有据此提交生成任务、安装 Skill 或修改线上配置。

## 结论

现有 Agent、sandbox、剪辑、存储和 Gemini 通路可以复用。主要缺口是把现有 SeedAudio 实现接到实际运行环境、装备 narration-led-film，以及完成真实旁白听审和 Agentic 视频审片验收。GPT Image 2 / Seedance 2.5 已有 CLI 契约，但此前验收未实际生成这两类素材。

需求来源：`/Users/zhangyuzhong/Downloads/短剧生成 0906/skills/narration-led-film/SKILL.md`。

该流程以连续主音轨为时间基准：故事稿 → Seed Audio 完整声音 → 听审 → 实音轨时间线 → GPT Image 2 参考图 → Seedance 2.5 视频 → 保留原音轨剪辑 → Agentic 审片与修改。第一人称指叙述视角，不默认要求严格主观机位。

## 当前状态与缺口

| 环节 | 已有证据 | 待完成 |
| --- | --- | --- |
| 工作流 Skill | 线上 Agent 当前装备 5 个 MediaKit Skill、vfs-cli、video-analysis，共 7 个；未装备 narration-led-film | 从用户提供的原目录导入并装备 narration-led-film，无需另行打包；按需要复用其他制作 Skill |
| 完整声音生成 | 本地 vfs-cli 新源码已有 `generate audio --model seed-audio-1.0`；第三方代理和资源服务也已有对应源码 | **线上 sandbox 仍是 v0.3.13 / e498454，没有 generate audio**。升级 CLI，并核验匹配的后端部署、数据库迁移、供应商服务端凭据和真实生成 |
| 主音轨切片上传 | Seedance 2.5 的现有 schema 接受 audio Resource 引用 | **线上 resource create 只支持 image/video**。随 CLI 升级启用 audio 上传，实际验收 WAV 切片 → Resource → 视频音频参考 |
| 参考图与视频 | 线上 CLI 已有 `gpt-image2` → `gpt-image-2`，以及 `seedance-2.5`；VFS 登录读取已通过 | 各生成一次，核对模型、权限/额度、引用素材、异步任务、资源 URL 和下载；schema 成功不证明供应商生成成功 |
| Gemini 听审 | 已有 key、代理和 google-genai 2.22.0；实际视频上传/分析/删除已通过 | 增加实际主音轨的独立听审和转录比对。当前 E2E helper 要求输入含视频流，不能直接用 WAV 验收 |
| Agentic 视频审片 | 原 video-analysis Skill 与 SDK 都支持该能力 | 当前 helper 未传 `processing:"agentic"`，仅保存 output_text。需实际启用，并保存/校验非空配对的 processing_call.id 与 processing_result.call_id；长任务要等最终完成再清理上传 |
| 时间对齐与剪辑 | 基础镜像已有 OpenMontage、FFmpeg 和 Whisper；既有验收覆盖转写、裁切、字幕重定位、音乐与混音；auto-story 已通过 MediaKit 裁切与文件落盘 | 用实际中文旁白校验句尾/词边界，保留连续原音轨并移除生成视频伴生音频，验收整条音画关系。无需先另建转写或剪辑服务 |
| 任务续跑与交付 | 已有外部 task_id/query、Workspace/S3 checkpoint 和 OpenMontage 项目状态文件 | 工作流保存每阶段提示词、task_id、Resource、原始素材、时间线、剪辑记录和审片证据，按阶段续跑；首条样片无需先新建任务队列 |

## SeedAudio 服务端要核验的事项

以下是本地实现明确要求的部署前提，**本次没有核实它们在线上是否已完成，不能当作已经缺失的服务**：

- thirdpart_proxy 暴露 `/pixel_director/api/v2/generation/audio_gen_sse`；使用专用 `SEED_AUDIO_API_KEY`，也支持服务端 YAML 的 `seed_audio_api_key`。凭据属于第三方代理服务，不应放入 auto-story sandbox。
- thirdpart_proxy 执行 `migrations/20260907_seed_audio_task_output.sql`，支持较大的字幕结果。
- pixel_director 核验 `scripts/migration/20260526_generation_task_id.sql`，并执行适用环境的 `scripts/migration/20260907_audio_generation_metadata.sql`，支持音频格式、小数时长、原始字幕和幂等资源注册。测试环境只涉及对应测试表。
- 实际调用验证永久音频、句/词字幕、重新查询和结算。源码的 mock/事务测试不能代替这些验收。
- 当前本地接入限制 prompt 最多 3000 字符、原始音轨时长最多 120 秒；长篇完整音轨需要明确分段与连续性处理。

证据：

- `/Users/zhangyuzhong/github/vfs-cli/docs/adr/0026-seedaudio-durable-generation.md`
- `/Users/zhangyuzhong/github/thirdpart_proxy/docs/design/seed-audio.md`，尤其第 35–41 行部署边界。
- `/Users/zhangyuzhong/github/pixel_director/docs/audio-generation-resources.md`，尤其第 23–28 行迁移边界。

## 环境与验收边界

本次只读线上检查确认 Agent 为 `agent_8kC4R3BvbC1FxNRzLOm63`，当前主模型是 `openai-codex/gpt-6-astra`，sandbox 为 auto-story。主模型负责执行工作流；声音、图片、视频与审片模型分别由工具调用，不需要全部加入 Pi 主模型选择框。

Host 注入 `RUNTIME_ENV=DEV`，且没有 VFS 地址覆盖，按 CLI 配置解析会默认使用测试环境 `pre-pixel-director.creativefitting.cn`。agentry 的域名与 VFS 数据环境不是同一个配置；后续若传入 VFS 项目 URL，其域名又会参与环境选择。

已经注入的变量名称为 GEMINI_API_KEY、GOOGLE_API_KEY、MEDIAKIT_API_KEY、RUNTIME_ENV、VFS_ACCESS_TOKEN、VFS_OSS_AK、VFS_OSS_SK、VFS_TOKEN；Agent 还有 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 配置。本次未输出凭据值。

之前的通过报告 [auto-story-e2e-2026-09-07.md](auto-story-e2e-2026-09-07.md) 证明底层集成可用，未证明本附件完整故事生产成功。当前 [video_analysis.py](../deploy/auto-story/e2e/video_analysis.py) 第 37–52 行体现了普通视频分析与 Agentic 验收之间的差别。[Google 官方视频文档](https://ai.google.dev/gemini-api/docs/video-understanding) 已核对相关请求字段和处理记录要求。

## 最小跑通顺序

1. 装备原版 narration-led-film，升级 sandbox VFS CLI，核验 SeedAudio 后端配套状态。
2. 用一个完整、约 30 秒的第一人称故事生成主音轨，保存原音轨、字幕和听审结果，测量真实时间点。
3. 生成少量参考图与 2–3 段视频，实际传入对应音频引用；关闭视频伴生音频，以连续主音轨剪辑。
4. 对实际成片进行 Agentic 审片，验证处理记录；修正后复审，交付 MP4、素材、时间线与审片记录。

故事片段、目标语言/画幅和生成范围属于制作输入；Sonilo 配乐服务不在这条旁白流程的必需依赖中，完整声音由指定的 Seed Audio 负责。
