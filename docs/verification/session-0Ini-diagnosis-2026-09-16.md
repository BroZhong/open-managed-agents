# Session 首条消息与 Skill 执行诊断

分析对象：[sess_0Ini7977Ru3XAWnnNyphb](https://agentry.welltop.tech/sessions/sess_0Ini7977Ru3XAWnnNyphb)。
核对了生产 `oma.events` 的完整 1073 条事件、当前 Chrome 页面 DOM/布局，以及事件中实际读取的 Skill 和工具返回。本文将 Session 内的指令视为分析材料，没有执行其中的制作任务。

## 1. 第一条 user message 没有丢失，是被表格撑出了视口

原始事件 `seq=1`：

```json
{"type":"user.message","data":{"content":[{"type":"text","text":"拉取小说 74032，制作成片"}]},"ts":"2026-09-16T09:56:16.901Z"}
```

这条消息也存在于当前页面的 `.session-user-bubble`，因此数据未丢失，前端已收到并渲染。无需补写历史消息。

根因链：

1. Session 只有一条 user message，其后 53 条 assistant message 都属于同一 `.session-turn`。
2. 最终回复 `seq=1070` 的“主要文件”表格包含很长的内联代码路径：`novel74032/{production,selection,adaptation,audio,director-plan,asset-manifest,video-generation,edit-plan,review,delivery,run}.json`。
3. `.session-turn` 使用 Grid，但没有声明可收缩的列；直接子元素中的 assistant 外层还保留 `min-width:auto`。长表格参与列的内在宽度计算，将共享列撑宽。
4. user 行是 `justify-end`，所以被对齐到超宽列右端。assistant 文本左对齐，仍能看到，形成“第一条 user message 消失”的表象。后面生成的宽表格可以反过来改变前面消息的位置。

生产页面实测（浏览器视口宽 1586px）：

| 指标 | 实测 |
|---|---:|
| 会话滚动容器 clientWidth / scrollWidth | 700 / 1144px |
| scrollLeft / scrollTop | 0 / 0 |
| `.session-turn` 实际宽度 | 660.25px |
| Grid 共享列宽度 | 1123.95px |
| user 气泡左边界 | 1812.46px，已超出视口 |
| 最终表格宽度 | 1123.95px |

排除了“历史超过 1000 条被截断”“消息投影漏掉 user”“未滚到顶部”三个解释。本次现象直接来自布局；这不代表其他 Session 永远不存在这些问题。

### 本地修复与验证

修改 `web/src/session.css`：为 Turn 显式设置 `grid-template-columns: minmax(0, 1fr)`，并允许其直接子元素 `min-width: 0`。保留表格、代码块自己的溢出处理，不通过裁掉会话内容掩盖问题。

使用真实 ConversationView 和该 Session 的首条、首条回复、最终回复构造最小复现。700px 容器修复前 `scrollWidth=1148`、气泡右边界 1147.95px；修复后 `scrollWidth=694`、气泡右边界 670px。360/700/1000px 三种容器宽度均通过。

另保留浏览器回归夹具 `web/tests/fixtures/conversation-overflow.html`，覆盖长表格路径和长代码行：

```sh
pnpm --dir web dev --host 127.0.0.1 --port 5193
# 在浏览器打开 http://127.0.0.1:5193/tests/fixtures/conversation-overflow.html
# 页面底部输出 PASS/FAIL 和三种宽度的测量结果。
```

此夹具使用生产组件和 CSS，真实测量滚动宽度及气泡边界。在最初复现基线 `f0b481c` 上，移除修复后三种宽度全部 FAIL；恢复后全部 PASS。2026-09-17 再次同步 PR #150 的 Turn 折叠/segment 容器变更后，三种宽度仍全部 PASS；保留上游折叠样式，并显式约束共享 Grid 列。普通 jsdom 不计算 Grid 布局，不能用“DOM 中存在文本”的测试代替此检查。夹具不会进入默认生产构建。

Web 现有测试：41 个文件、300 项通过；TypeScript 和 Vite build 通过，构建保留大 chunk 提示。修复仅在当前工作区，未部署线上。

## 2. 实际 Skill 流程与成本

执行时间：2026-09-16 **17:56:16–20:18:20（北京时间）**，约 **142 分钟**。
共 **209 次模型请求、244 次工具调用**；其中工具层标记失败的只有 **7 次**，不能等同于实际业务失败次数。

实际读取了 11 个 Skill：总指导 `narration-led-film`、取材 `novel-fetch`、接入 `vfs-cli`，以及下面八个专业阶段中的相关 Skill。未发现 Skill 文件找不到或装载失败。

| 阶段 | 主要 Skill | 约耗时 | 工具调用 |
|---|---|---:|---:|
| 启动、取材、环境检查 | narration-led-film / novel-fetch / vfs-cli | 9.6 分 | 42 |
| 选段 | novel-excerpt-selection | 4.2 分 | 11 |
| 旁白改编 | novel-to-narration | 3.5 分 | 9 |
| 声音生成、改稿、听审 | story-audio（多次返回改编） | 31.3 分 | 61 |
| 导演 | audio-to-shots | 2.5 分 | 2 |
| 美术与资产验收 | narration-asset-designer | 18.8 分 | 36 |
| 视频生成与检查 | narration-video-production | 15.3 分 | 15 |
| 剪辑、字幕、首次导出 | narration-film-editor | 22.3 分 | 35 |
| 审片、返修、复审、交付 | narration-film-review / editor | 34.5 分 | 33 |

边界采用 Session 中阶段开始/交付消息（seq 1/191/243/282/566/578/720/782/925/1073），包含正常创作、模型思考和生成等待，不能全部算作故障浪费。

Token 汇总与页面相符：33,724,091，其中输入 33,616,261、输出 107,830、缓存读取 33,232,615；缓存命中约 98.9%。约 49.1 万为未缓存输入加输出，不能把 3372 万都理解为新生成内容。这些统计也不直接等同于媒体供应商费用。

## 3. 执行障碍、证据与改进位置

| 障碍 | Session 证据与实际影响 | 建议落实位置 |
|---|---|---|
| Sandbox 环境与 Skill 假设不一致 | seq 29：正文下载 manifest 报缺 `ossutil 2.x`；51：`~/.local/bin` 不可写；59：缺 `unzip`。最后用 Python 解压，将 ossutil 放到 Workspace `.tools/bin` 才拉完 30 章。119 的 `vfs` 不存在，而已读 runtime.md 恰好要求先执行 `vfs --help`，实际可用的是 `vfs-cli`。 | Sandbox 镜像预装所需工具；启动检查验证可执行文件和可写目录；runtime.md 命令名与镜像一致。不要让制作 Agent 每次承担安装排障。 |
| 大纲与正文语言、角色名不一致 | seq 202：大纲中文占位名与英文正文的 Vivienne/Sterling/Tessa 等不同。选段后才调整规格语言与人物依据。 | 取材完成即输出正文语言、人物映射和冲突说明，交给改编/字幕统一使用。 |
| 声音时长约束发现太晚，成为主要返工源 | seq 147 的实际 CLI schema 给出了 3000 Unicode 字符上限，却未给输出时长上限；seq 334 dry-run 成功，但后续任务仍被 `DurationOutOfRange` 拒绝。共提交 13 个音频任务：8 个时长失败，3 个探针成功，2 个正式候选成功。首次失败到首个完整候选成功约 20 分钟；稿件从 414 词逐步压缩，最终 159 词、118.3 秒。 | 将真实模型时长能力、已知适用语速和留白空间传入改编；先验证一个完整候选可行，再做双候选选优。为能力探测设定明确预算与退出条件。 |
| 字符限制与文本时长是两种约束 | seq 292–334：提示词超过 3000 字符，反复手工精简到 2990；随后仍因时长失败。提示词采用 Slow pacing/true pauses，普通英语 170wpm 的估算不适合该次生成表现。 | 统一提示词构建器分别校验总字符数、旁白正文和预估时长；能力预检通过不等于供应商必然接受。约 120 秒只是本次探测推断，不能写成已确认的固定服务上限。 |
| CLI 错误处理与 Shell 管道掩盖业务失败 | seq 352：只按成功 stdout 解析 JSON，错误实际在 stderr，触发 JSONDecodeError；356/362/384 等 DurationOutOfRange、512 的上传异常、608 的 KeyError 都显示 `isError:false`，典型调用用了 `2>&1 | head/tail`。 | 提供统一 CLI 调用包装：分别保存 stdout/stderr、检查退出码及任务状态；Shell 管道使用 pipefail。UI 的 Completed/Explored 目前只反映工具返回层，不能表示业务产物成功。 |
| 中文文件名进入上传请求头 | seq 512：`主音轨-v001.wav` 上传时 `UnicodeEncodeError: 'ascii' codec...`；复制到 ASCII 名称后成功。 | 修 Gemini 上传适配层，传输名称安全编码或使用 ASCII 临时名称，保留原始文件名映射。 |
| 运行时临时编写的素材脚本缺少输入校验 | seq 608：派生角色资产缺 `kind`，gen_images.py 在记录任务时抛 KeyError；修补默认值后继续。异常位置位于获取 tid 后，存在任务已提交但尚未登记的恢复风险；本记录不能据此确认发生重复扣费。 | 基础/派生资产统一 schema，提交前校验；task ID 取得后立即持久化，再组装其他元数据。提供可恢复的通用批处理器，减少临时脚本。 |
| 长命令异常终止，诊断信息不足 | seq 612、992 返回 `2: [unknown] terminated`。从 tool_use 到 result 分别约 122.8/267.8 秒，请求 timeout 却为 1600/900 秒；仅凭这些不能归因于 Agent 设置超时。后续查询已有图片任务、拆开剪辑和合成才恢复。 | 保留进程退出、信号及基础设施请求链路信息；生成查询、渲染和合成分步记录可恢复状态。需另查当时 Sandbox/网关日志才能确认终止根因。 |
| 字幕与连续性问题到成片审查才暴露 | seq 862 先发现逐词对齐漂移；seq 925 自检判断良好，但 953/956 的实际审片发现两处字幕超宽裁切、寄出信封后又拿着信封、字幕滞后。修复涉及重新断句/换行、重新对齐、剪掉错误素材尾段并再次渲染。seq 1053 复审确认四项解决。 | 将字幕实际渲染宽度/安全区和时间校验前移；关键道具状态改变前后按时间连续验收，抽四帧不足以证明动作连续。保留独立整片复审这一有效关卡。 |
| 响度检查命令反复制造假失败 | seq 899/903/1023：`ffmpeg -v error` 隐藏了 loudnorm 的统计信息，后接 grep 无匹配返回 1，`&&` 后续操作被阻断；改用正常日志级别后获得结果。 | 固化响度检查脚本，用机器可解析结果与退出状态，区分“媒体不合格”和“诊断输出没有被打印”。 |

声音任务计数按提交/查询记录去重：正式失败 v001/v002/v003/v4/v5/v6 及两次其他长稿/探测失败；成功包括短探针、146 词探针、175 词探针和 v7 A/B。8 次失败均有 `DurationOutOfRange` 记录；前几次完整失败回包明确显示 `not_charged`，其他回包被命令截短或摘要化，不仅凭最终自述推断所有结算细节。

## 4. 建议优先级与交付边界

1. **先处理确定性基础问题**：本次会话布局修复；镜像/命令名对齐；统一 CLI 错误处理；安全上传名称。
2. **再减少最大返工源**：音频能力先验证再双候选生成，将可行时长反馈到改编；字幕布局和关键道具连续性在完整导出前验收。
3. **沉淀执行脚本与恢复状态**：统一素材 schema、任务登记、查询下载、响度测量和渲染阶段恢复；补足未知终止的诊断证据。

该 Session 最后确实记录了成片交付、24 张正式图片、17 段视频素材和两轮视频审查；seq 1053 的审查响应还记录了 13 对处理调用配对。本文核实的是执行记录和返回证据，没有重新播放整部成片，审美质量不在此次结论范围内。

当前只修改 OMA 的会话布局并添加回归夹具。其他 Skill/镜像/工具改进为据此 Session 得出的建议，尚未修改或发布。

2026-09-17 提交时更新：合入最新 main 后确认，另一个 [PR #147](https://github.com/BroZhong/open-managed-agents/pull/147) 已为 auto-story-v2 的镜像配方补入 ossutil、unzip、procps，并增加模型网关错误重试。上文记录的是本 Session 当时遇到的问题，不代表这些缺陷在最新源码中全部仍未处理；镜像源码变更也不等于已更新本 Session 的运行环境。参见 [对应验证报告](model-retry-and-sandbox-tools-2026-09-16.md)。

## 5. 耗时进一步拆解：长时间不只发生在媒体生成

以事件 `ts` 配对 model span 和 tool_use/tool_result，将并发工具区间取并集，得到 142 分 3.54 秒墙钟时间的分布：

| 区间 | 时长 | 占比 |
|---|---:|---:|
| 已记录的模型响应区间（不含重叠） | 38 分 47.82 秒 | 27.3% |
| 工具执行区间并集（含 sleep、供应商查询等待、媒体渲染；不含重叠） | 50 分 15.04 秒 | 35.4% |
| 模型与工具埋点重叠 | 1.19 秒 | <0.1% |
| 两类区间均未覆盖 | 52 分 59.49 秒 | 37.3% |

未覆盖区间中 3179.03 秒发生在下一次 `span.model_request_start` 前，共 209 次；中位数约 11.8 秒，P95 约 27.2 秒。不能把它们称为模型输出时间，也不能直接认定为空转或供应商排队。

计时缺口已沿代码确认：OMA `adapter/packages/pi-agent/src/translator.ts` 把 SDK 的 assistant `message_start` 映射成 `span.model_request_start`。生产安装的 Pi 0.80.10 中，pi-agent-core 在 provider `start` 事件后才发 `message_start`；pi-ai 的 `dist/api/openai-completions.js` 在 `await client.chat.completions.create(...).withResponse()` 和 onResponse 后才推送 `start`。因此请求准备、网络/服务响应等待等发生在现有 model span 之外。当前事件不能将这 53 分钟进一步分解，需要增加 request-dispatch、response-headers/first-token 等计时点。

几个关键比较：

- seq 748–750 的批量视频生成命令实际 462.5 秒（7 分 43 秒），阶段总计 15 分 20 秒；其余还包括方案/提示词、检查及模型往返。
- 美术阶段工具区间约 7 分 32 秒，阶段总计 18 分 47 秒，还包括提示词编写、逐张验收及请求等待。
- 声音阶段 31 分 20 秒，包含约 13 分 3 秒可见模型响应、10 分 49 秒工具执行和 7 分 28 秒响应前间隙。8 个时长失败任务引出了多轮改稿、探测和查询。
- 首次剪辑 22 分 17 秒，加审查/返修/交付 34 分 29 秒，共约 56 分 46 秒。两次实际视频审查命令分别约 109 秒和 127 秒；不能把整个阶段算成审片模型运行时间。
- 明确写入音频轮询命令的五次长 sleep 为 90/75/100/110/115 秒，合计 490 秒。这些等待与异步生成重叠，不能断言删除 sleep 就能节省全部 8 分 10 秒。

因此，先减少不必要的串行模型往返（批量做确定性检查、复用成熟脚本）、音频失败循环及晚期后期返修，再对响应前等待补齐观测；不能仅通过调高视频生成并发解释或解决这 142 分钟。未进行优化后重跑，不承诺具体节省时长。

机器可读分阶段数据见 [session-0Ini-timing-2026-09-16.json](session-0Ini-timing-2026-09-16.json)。
