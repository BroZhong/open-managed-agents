# auto-story 第一人称故事验收

执行时间：2026-09-07 至 2026-09-08（Asia/Shanghai）。**测试环境的真实声音 → 参考图 → 音频切片上传 → 视频生成 → 原音轨剪辑 → Agentic 审片已跑通。** 样片有轻微步态瑕疵，声音美术有听审分歧；不将接口通过等同于全部内容完美。

- [auto-story Agent](https://agentry.welltop.tech/agents/agent_8kC4R3BvbC1FxNRzLOm63)
- [真实故事 Session](https://agentry.welltop.tech/sessions/sess_HFJ2dDQcgt3GrsT27Df8B)
- [VFS CLI v0.3.14 发布](https://github.com/welltop-cn/vfs-cli-dist/releases/tag/v0.3.14)
- 本地交付目录：`/Users/zhangyuzhong/Downloads/auto-story-验收-20260908/`。
- 完整 Workspace：`/home/user/narration-story/`，包含提示词、请求、任务记录、原始素材、字幕、时间线及审片证据。

## 配置与发布

| 项目 | 实际配置/证据 |
| --- | --- |
| 主模型 | 保留用户选择的 `openai-codex/gpt-6-astra`；最高支持思考强度。K3、Sol 也可选 |
| 原版 Skill | 5 个 MediaKit + VFS + video-analysis + narration-led-film，共 8 个 |
| 故事 fork | `skill_lUR9el5_YtwYWNkybTcHt`；VFS fork `skill_7hR5_AiyKSLPm16GsW3k6` |
| Skill 来源 | 用户原目录 `/Users/zhangyuzhong/Downloads/短剧生成 0906/skills/narration-led-film/`；未复制进代码仓库/镜像，未修改原 Skill |
| VFS 地址 | `https://pre-pixel-director.creativefitting.cn`、`https://pre-api.welltop.tech`；未切到 VFS 正式环境 |
| 凭据 | 保留 Host 的 Agent allowlist Secret 注入与可达代理；未把服务端 SeedAudio key 放进 sandbox |
| CLI | v0.3.14，源码 `ac531bc24f13ed9db1bd4ecc42ab6ddfb9377dc5`；Go test/vet 通过，发布 CI `34137834451` 成功 |
| Sandbox | `oma-sandbox:auto-story-0.1.1`，digest `sha256:bdf9bdc74ad8e1f289b3993bb8154e388a505a43c3e24d47cbaae874e5ad49f4` |
| 运行实例 | 初始 Pod `auto-story-hqn4j`；第三回合 `auto-story-9snp7`，均使用上述 digest |
| Host 修复 | `oma-server:auto-story-tools-c8300f5`，digest `sha256:5a83e4f5eba8a4739d617186d167101fae08743323e1538f8922896055cc7509` |
| Host 部署验证 | `server` 与 `seed-pi-auth` 同 digest，rollout/health 成功；Pod `oma-server-7ffb98767f-624rv` 的实际 API import 快照与源文件哈希一致 |

[configure-narration.mjs](../deploy/auto-story/configure-narration.mjs) 幂等配置测试路由、精确模型和同步 Gemini；保留现有模型、sandbox 与代理。原版视频 Skill 自包含，可用镜像内官方 SDK 编写调用；Workspace 中的 Python helpers 是验收脚本，不是重新打包的 Skill。

## 真实生成与剪辑

| 产物 | 模型 | task ID | Resource |
| --- | --- | --- | --- |
| 27 秒完整旁白 | `seed-audio-1.0` | `audio_4494b425-909e-49e6-8944-280cca0d3d28` | `103932` |
| 2048×1152 参考图 | `gpt-image2` | `06514068-eda6-492d-b328-3f5257041efb` | `103933` |
| 主音轨 0–14 秒切片 | 上传原始 PCM | — | `103935` |
| 主音轨 14–27 秒切片 | 上传原始 PCM | — | `103934` |
| 第一段 14 秒画面 | `seedance-2.5` | `c8477dd2-b318-4728-9b9a-f90b022804bc` | `103937` |
| 第二段 13 秒画面 | `seedance-2.5` | `71c281d8-b018-4b16-a0e8-5d12b636d943` | `103936` |

生成次数：一次声音、一次图片、两次视频；两个切片各上传一次。所有生成先存 task ID，再查询原任务。没有新建或修改 VFS Project/Teamwork。视频请求同时引用同一人物图片和对应真实音轨切片；切片重新下载后与本地字节一致。

`master.wav` 是 27.000 秒、40 kHz 双声道 PCM，SHA-256 `c5268033cf16af69e602a885235ffa4358c9b237cdc324a98ca5098510ce48a7`。`subtitles/provider-original.json` 保留供应商句/词时间，最后一个字结束于 25.760 秒，留尾 1.240 秒。Gemini 先独立转录实际音频，再与原稿对照；字词一致、末句完整。

两段直接拼接有抬头姿态重置。Agent 自行查看真实帧后，使用第一段动态门灯局部近景作 11.5–14.0 秒插镜，修正衔接并对齐亮灯；未追加生成。`edit/timeline.json`、`edit/final.filtergraph.txt`、`edit/assemble.py` 与命令保留剪辑依据。原始视频伴生音轨全部移除，成片仅使用连续 master 经重采样/AAC 编码的音轨。

## 成片与独立核验

| 项目 | 结果 |
| --- | --- |
| 文件 | `final.mp4`，8,461,832 bytes |
| SHA-256 | `8da0b8e28746e844e397e6e70ff41aefb1570a9eeca0a712e59139af0aa36517` |
| 视频 | H.264，1280×720，24 fps，648 帧，27.000 秒 |
| 音频 | 单一 AAC 音轨，48 kHz 双声道，27.000 秒；完整解码成功 |
| 音轨来源核对 | 与原 master 同步解码到 16 kHz 单声道，均 432,000 个样本；全程相关系数 0.999916，末 3 秒 0.999907 |
| 门灯与衔接 | 独立抽帧：12.750 秒灯暗、13.000 秒灯亮，在 12.64–13.28 秒词点窗口内；14 秒回到低头人物，避开原重置 |
| 邻居与结尾 | 17 秒邻居出现、18 秒举掌、19 秒放手；26.9 秒双方仍在微笑，无提前黑场 |

抽帧只提供采样视觉证据，音频相关性只验证来源和连续性；两者均不冒充完整听审或逐帧动作审查。

## 实际 Agentic 审片

Pi 的 Agent 子代理使用同一个 sandbox，对上述 SHA 对应的实际 `final.mp4` 调用官方 `google-genai==2.22.0`、`gemini-3.8-flash`、`processing:"agentic"`、同步 Interactions。返回 `completed`、**7 组非空且一一配对的 processing_call/result**，`upload_deleted=true`。`store:false` 的完成响应没有 interaction ID，未伪造 ID。

证据保存在 Workspace：

- `reviews/gemini-final-v1.evidence.json`：实际输入哈希、时长、模型、7 组处理记录与清理结果。
- `reviews/gemini-final-v1.md`：原始模型审片意见。
- `requests/gemini-final-v1.json`、`results/gemini-final-v1-run.*`：请求、输出与执行状态。
- `reviews/gemini-audio-sync.transcript.md`、`.md`、`.evidence.json`：独立音频转录及对照听审。

Gemini 判断核心叙事成立、旁白一致、画外音与结尾完整，同时指出开场步态轻微滑步。模型输出中“毫秒级复核”等过强表述不采纳；具体剪辑时间以本地帧和供应商字幕为准。几次音频审查对雨声和音乐起点意见不一，保留为声音美术疑点，不声称完全符合声音提示词。双手抱箱与“拎着”存在用词/动作差异，但不影响本次基础设施验收。

## 本轮修复与限制

- 本项目的 Pi sandbox 适配层原先缺少 `detectImageMimeType`，且经 UTF-8 字符串接口读取 PNG；自写的 Python grep 也将 pyc 当文本。输出中的 NUL 触发本平台 PostgreSQL JSONB 存储错误，导致回合中断。原版 Pi 0.80.10 的默认 read 已支持原始字节和图片识别，默认 grep 使用 ripgrep；本次修复归属于本项目适配层。用同一参考图对照，原版 read 返回 text + image，而旧 sandbox operations 返回含 NUL 的 text。现在原字节经 sandbox exec/base64 传输，按 magic 识图；非支持二进制明确拒绝，grep 跳过含 NUL 文件。本项目事件转换器也改为保留图片 content block，以支持跨回合回放。真实 Session seq 320 看图成功，后续多次真实图片读取成功。
- Host 增量镜像同时刷新 pnpm 的实际 `file:` 依赖快照，避免仅覆盖源码但运行旧工具。修复提交 `5fe3aa6`、`c8300f5`。
- Gemini 后台音频/Files 路线失败，固定使用经验证的同步路线。SDK 2.22.0 Interactions 隐式重试已关闭；真实离线 transport 测试要求 503/读取超时只发一次 POST。
- 单独的 3 秒 Agentic canary 曾把纯音误判成人声：配对证明能力执行，不保证内容正确。其后台诊断上传 `files/goldpw4eaamn` 尚无可靠终态，继续保留；Files 返回到期时间 2026-09-09 15:44:47 UTC。此诊断清理待定不影响已经完成并清理的同步成片审片。收据在 `/private/tmp/oma-auto-story/agentic-canary*.json`。
- 首次被拒绝的音频上传已获得删除成功回应；再查403无法独立确认404。真实同步音频及成片审片均记录上传清理成功。

验证：Pi 完整 118 项测试及类型检查通过；Gemini helpers 20 项离线测试通过；provision 单元 2 项、真实 API 集成 4 项通过；VFS CLI Go test/vet、发布 CI、sandbox 无网络烟测、实际生成与 Agent 工具执行通过。之前的媒体基础验收见 [原报告](auto-story-e2e-2026-09-07.md)。
