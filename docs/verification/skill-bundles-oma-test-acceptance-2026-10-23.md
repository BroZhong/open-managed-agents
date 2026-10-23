# oma-test Skill Bundle 验收（#270，2026-10-23）

**结论：#270 的验收项在 oma-test 上全部通过；"PR 已开、CI 全绿"一项不在本次任务范围内。**

- 共 31 次分镜运行：1 次 smoke 加 30 次错峰批量，涉及 124 个 Session（31 个根、93 个子）。31 次全部通过产物验收、恢复契约和 Skill 契约。
- 每个根 Session 只在第一个 Turn 安装一次 Skill Set，31 次全部 `installed`，耗时 p50 953 ms，p95 1,284 ms。
- 93 个子 Session 一共跑了 110 个 Turn，没有一次安装，也没有写出任何 install span。
- 运行窗口内，Runner 和 API 日志里 Storage 544、`DatabaseTimeout`、`storage/v1` 都是 0 次，`session.error` 也是 0。
- 子 Turn 从 `session.status_running` 到第一次模型请求，p50 从改造前的 6.7 s 降到 0.5 s。
- `precise-subtitles` 的字体在 Sandbox 里字节正确，并且只读。
- 编辑器的文本编辑、二进制上传和预览都可用，分别通过 API 和真实 Web 控制台验证过。
- 没有发现 Skill Bundle 的缺陷。

**环境：**
- API `https://agentry-test.welltop.tech/api`，namespace `oma-test`，schema `oma_test`。
- 镜像：`oma-server@sha256:efc57719…7239b`（`feat/skill-bundles` 的 `e2edb6655355`），`oma-web@sha256:77236e3c…9976`。2026-10-23 01:44–01:46Z 发布，上一版是 `395e30e564f0`。
- Runner 2 副本（`pq95k`、`sk7hg`），每个 2 CPU / 8 Gi。整个测试期间没有重启，一直 2/2 Ready。
- 迁移 0022/0023 已执行，schema 内 77 个 Skill 全部有 bundle。bundle 在 OSS `agentry` 的 `__oma/skills/<tenant>/<sha256>.zip` 下。
- Fixture 与 10-21、10-22 相同：
  - Agent `agent_MQphuTegkqyda82d_elSj`，pi-agent，`deepseek/deepseek-flash`，thinking high，Sandbox 模板 `oma-scale-test-20261021`。
  - `sandbox.env` 与 10-21 的覆盖完全一致，凭证全部为空。`updatedAt` 仍是 2026-10-21T04:33:09Z。
  - 装备 19 个 Skill，19 个都有 bundle，解压后合计 4,820,727 B。预期 Skill Set hash 为 `a49cf741…1299c`。
  - Workspace `scale_storyboard_200_20261021`，4 个输入与 10-21 的本地副本逐字节一致。
- 工作负载：剧本 EP29，Director → DP → Formatter 三个同步子 Agent，40–50 镜，11 列 `storyboard-dp.csv`。每个 run 只写自己的 `outputs/sk-20261023-NN/`。
- 证据：本文件旁的 JSON。原始事件元数据、日志和 SQL 采样在本地私有目录 `oma-wt/storyboard-20261023-skills/`，不入库。

## 1. 方法

- **复用 10-22 的工具。** 以下脚本都是复制后再改，没有修改原件：
  - `lib.mjs` 是带测试守卫的 client：origin 必须等于测试域名，路径必须以 `/api/v1/` 开头，`redirect: "error"`。
  - 另外复用了 `prompt.mjs`、`driver.mjs`、`observer.mjs`、`collect.mjs`、复用的 CSV 校验器（自检通过，hash 一致）和 `apikey.mjs`。
  - 新增了三项：install span 的分析；每个 Turn 的延迟（`status_running` 的 ts → 首个 `span.model_request_start` / 首个工具结果的 `data.timestamp`）；Skill 契约检查（根 Session 恰好一对 `installed`，子 Session 为 0）。
- **改造前（BEFORE）的数据来源。** 10-22 那 17 个根、51 个子 Session 走的是旧的 Read-only Projection 路径，fixture 相同。我用 GET 重新读了它们的事件，并用**同一份分析代码**计算延迟。只要 Turn 在首个模型请求或工具结果之前发生过接管，该项就从统计里剔除。
- **运行过程：**
  - smoke：1 个根。
  - 批量：30 个根，每 10 s 发一个（6 个/分钟），02:46:27–02:51:48Z 发完，最后一个 03:06:33Z 完成。同时最多 30 个根在跑，其中最多 29 个子 Session 处于 running。
  - 没有注入故障。
  - observer 每 20 s 记录一次 Pod、`kubectl top`，并增量保存 Runner 和 API 日志；每 30 s 记录根、子 Session 和委派状态。
  - 运行中和结束后，用只读 SQL 采样 `oma_test.delegation_environments`。
- **编辑 / 跳过 / 重装：** 建了一个 scratch Agent，只装备 Library 里的 `precise-subtitles`，在一个 Session 里跑了 4 个 Turn，详见第 5 节。
- **编辑器：** 在 scratch Agent 的 fork 上直接调接口，并用 browser-harness 驱动已登录的测试控制台，详见第 6 节。

## 2. 每次运行

"子 Turn / span"列的含义：子 Session 的 Turn 总数 / 这些 Turn 写出的 install span 数。

| run | 批次 | 根 Session | 时长 s | 镜头 | 子/执行 | 模型请求 | 工具调用 | 安装 ms | 根 running→模型 ms | 子 Turn / span | 产物 | 恢复契约 | Skill 契约 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 01 | smoke | sess_nlsAhiR7GQLj1s2jJkp87 | 745 | 47 | 3/4 | 79 | 99 | 1,085 | 4,771 | 4 / 0 | 通过 | 通过 | 通过 |
| 02 | 批量 | sess_PNmy_KhBInHa8W8G1jp7C | 755 | 47 | 3/3 | 86 | 111 | 958 | 198 | 3 / 0 | 通过 | 通过 | 通过 |
| 03 | 批量 | sess_3TvveVTFtxga3qJ_BfLdy | 836 | 48 | 3/5 | 99 | 121 | 959 | 165 | 5 / 0 | 通过 | 通过 | 通过 |
| 04 | 批量 | sess_RP_e-wezwPdzMAWE5IsPm | 1186 | 45 | 3/3 | 111 | 137 | 916 | 179 | 3 / 0 | 通过 | 通过 | 通过 |
| 05 | 批量 | sess_s25LOEdRayHh02S7xI7qs | 713 | 45 | 3/3 | 81 | 101 | 982 | 173 | 3 / 0 | 通过 | 通过 | 通过 |
| 06 | 批量 | sess_TAJWFUdc9VReAQL6zU3L3 | 791 | 46 | 3/3 | 97 | 125 | 954 | 149 | 3 / 0 | 通过 | 通过 | 通过 |
| 07 | 批量 | sess_SFdOdzutDqZGe2-2FGe9Q | 821 | 47 | 3/4 | 90 | 109 | 1,770 | 392 | 4 / 0 | 通过 | 通过 | 通过 |
| 08 | 批量 | sess_3SzkNhtqNnD5ngb4ecxS2 | 786 | 48 | 3/3 | 73 | 94 | 891 | 258 | 3 / 0 | 通过 | 通过 | 通过 |
| 09 | 批量 | sess_p-rBLpy3UcnW-uPr0Js0N | 858 | 45 | 3/4 | 87 | 108 | 958 | 173 | 4 / 0 | 通过 | 通过 | 通过 |
| 10 | 批量 | sess_Avb9Q9jvOE9nA-C7MT5ba | 561 | 46 | 3/3 | 74 | 93 | 913 | 180 | 3 / 0 | 通过 | 通过 | 通过 |
| 11 | 批量 | sess_gYqlBNG3fUjW2IriEz9Rd | 789 | 46 | 3/4 | 77 | 96 | 916 | 150 | 4 / 0 | 通过 | 通过 | 通过 |
| 12 | 批量 | sess_yNIdF-VE1xdFjaU_1oycz | 771 | 46 | 3/5 | 94 | 117 | 922 | 4,465 | 5 / 0 | 通过 | 通过 | 通过 |
| 13 | 批量 | sess_hxtTVynw8Mb2muF2YzS7- | 773 | 47 | 3/4 | 86 | 102 | 1,225 | 185 | 4 / 0 | 通过 | 通过 | 通过 |
| 14 | 批量 | sess_4OxryhxFCYDCeXRQ2sikc | 670 | 47 | 3/3 | 82 | 106 | 890 | 224 | 3 / 0 | 通过 | 通过 | 通过 |
| 15 | 批量 | sess_NTIPk6YqZ2NVFbAkNAt8E | 742 | 47 | 3/3 | 73 | 99 | 913 | 176 | 3 / 0 | 通过 | 通过 | 通过 |
| 16 | 批量 | sess_fbOpBP7NJQOj6KSQ_afFh | 777 | 47 | 3/4 | 104 | 120 | 896 | 241 | 4 / 0 | 通过 | 通过 | 通过 |
| 17 | 批量 | sess_ri04L7YBoD9g0ykPRa1k1 | 685 | 45 | 3/5 | 88 | 105 | 889 | 166 | 5 / 0 | 通过 | 通过 | 通过 |
| 18 | 批量 | sess_NklHKTn1yP8zzBE9s68m6 | 631 | 46 | 3/4 | 71 | 94 | 1,047 | 168 | 4 / 0 | 通过 | 通过 | 通过 |
| 19 | 批量 | sess_4ZssyX8J_WKMI9cMpe-RX | 673 | 50 | 3/3 | 67 | 94 | 885 | 172 | 3 / 0 | 通过 | 通过 | 通过 |
| 20 | 批量 | sess_jn_JNbVooGpaaN-rfsonq | 780 | 46 | 3/4 | 96 | 110 | 1,267 | 215 | 4 / 0 | 通过 | 通过 | 通过 |
| 21 | 批量 | sess_fGN8NVW4QkrU-htI1YoYg | 757 | 47 | 3/3 | 86 | 111 | 883 | 195 | 3 / 0 | 通过 | 通过 | 通过 |
| 22 | 批量 | sess_8mZK-EU9Txn7QdHt5pge6 | 749 | 49 | 3/3 | 78 | 97 | 953 | 343 | 3 / 0 | 通过 | 通过 | 通过 |
| 23 | 批量 | sess_Pn-h1o58zW7ucmKCxYNf2 | 801 | 46 | 3/4 | 94 | 123 | 1,293 | 463 | 4 / 0 | 通过 | 通过 | 通过 |
| 24 | 批量 | sess_jsP5r6cTZWkfk-Abw1lLl | 840 | 47 | 3/4 | 92 | 122 | 881 | 390 | 4 / 0 | 通过 | 通过 | 通过 |
| 25 | 批量 | sess_VU__LY5xTe-KAR6m6A1OF | 825 | 46 | 3/3 | 88 | 108 | 1,210 | 186 | 3 / 0 | 通过 | 通过 | 通过 |
| 26 | 批量 | sess_LoE5WKRJhhdE1J0tviS-c | 839 | 47 | 3/3 | 100 | 122 | 895 | 241 | 3 / 0 | 通过 | 通过 | 通过 |
| 27 | 批量 | sess_spdalUzd8VyV6-YjSb0Z2 | 734 | 46 | 3/4 | 90 | 110 | 887 | 174 | 4 / 0 | 通过 | 通过 | 通过 |
| 28 | 批量 | sess_8PgzT2baNvJkdL5oL-6tn | 725 | 48 | 3/3 | 80 | 101 | 1,274 | 503 | 3 / 0 | 通过 | 通过 | 通过 |
| 29 | 批量 | sess_k7hMaV4D42evS9ZreMncC | 643 | 45 | 3/3 | 73 | 99 | 1,238 | 266 | 3 / 0 | 通过 | 通过 | 通过 |
| 30 | 批量 | sess_qHUALY1jGBba7IlNebF55 | 654 | 48 | 3/3 | 74 | 92 | 879 | 450 | 3 / 0 | 通过 | 通过 | 通过 |
| 31 | 批量 | sess_65DiPUO9FssLxFX7rq8yg | 714 | 45 | 3/3 | 78 | 97 | 1,076 | 368 | 3 / 0 | 通过 | 通过 | 通过 |

- **产物验收**（方法与 10-21、10-22 相同）：
  - 11 列表头完全一致，镜头数 45–50（p50 47），镜头号唯一，时长为正整数，镜头参数为三段，Skill 校验器报 0 个错误。
  - `result.json` 与持久化状态一致。
  - 每个 run 都有 3 个不同的同步子 Session，串行执行，没有嵌套委派。
  - 各 run 的 CSV hash 互不相同，没有子 Session 被多个 run 共享。批量新增的 387 个文件都在各自的 run 目录下，越界文件为 0。
- **恢复契约**（根和子 Session 都检查）：
  - 每个输入恰好一个 `session.turn_completed`，pending 全部确认。
  - 每个 tool_use 恰好一个结果，每次 Agent 调用只对应一次执行。
  - 接管 0 次，outcome unknown 0 次。
- **回修执行：** 14 个 run 共有 17 次回修执行（执行数大于子 Session 数）。这是模型对同一个子 Session 的合法追加调用，与 10-21 run-009 的情形相同。这 17 个追加的子 Turn 也都没有安装。
- **时长：** 批量 p50 764 s，均值 763 s。10-22 两路无扰动基线的均值是 629 s。本次并发高得多（30 个根），回修执行也更多。耗时主要花在模型推理上，准备阶段在每个子 Turn 上反而节省约 6 s（见第 4 节）。

## 3. Skill Install 与环境绑定

| 统计 | 根 Session | 子 Session |
|---|---:|---:|
| Session 数 | 31 | 93 |
| Turn 数 | 31 | 110（93 个首个 Turn + 17 个回修 Turn） |
| `span.skills_install_start` / `_end` | 31 / 31 | 0 / 0 |
| outcome | installed 31，failed 0，aborted 0 | – |
| 安装发生在首个 Turn | 31/31（installId 均为 `1.1`） | – |

- **安装耗时：** 31 次的 `durationMs` p50 953、p95 1,284、max 1,770、min 879 ms，均值 1,023 ms。只看批量的 30 次：p50 938、p95 1,284 ms。
- **安装内容：** 每次都是 `skills=19`、`downloaded=19`、`bytes=1,978,398`（zip 字节，解压后 4.8 MB），setHash 都是 `a49cf741…1299c`，与按 SQL 中 19 个 (name, bundle_sha256) 本地算出的值一致。
- **环境绑定（只读 SQL，03:13Z）：**
  - 31 个根都有绑定，`skills_set_hash` 等于预期 hash，`skills_sandbox_id` 等于 `sandbox_id`，`skills_generation` 已写入。
  - 共 31 个不同的 Sandbox，`creation_pending` 为 0。
  - 93 个子 Session 的 `delegation.sandboxSessionId` 都等于其父根 Session，即共用根的绑定，子 Session 自己没有绑定行。
  - 02:50Z 的中途采样：已启动的 20 个根同样全部符合。

## 4. 延迟：改造前后对比

两边都用同一份分析代码计算，单位 ms，格式为 p50 / p95 / max。

| 指标 | BEFORE：10-22 Read-only Projection（17 根 / 52 子 Turn，1–8 路并发） | AFTER：10-23 Skill Bundle（31 根 / 110 子 Turn，最多 30 根 + 29 子并发） |
|---|---|---|
| **子 Turn**：status_running → 首次模型请求 | 6,668 / 7,386 / 8,491 | **502 / 857 / 4,215** |
| 子 Turn：status_running → 首个工具结果 | 9,802 / 10,914 / 15,660 | 3,606 / 6,378 / 19,236 ¹ |
| 子 Turn：首个 tool_use → 结果 | 2,082 / 2,293 / 2,537 | 2,104 / 2,404 / 3,303 |
| **根首个 Turn**：status_running → 首次模型请求 | 850 / 4,078 / 4,211 | 198 / 2,484 / 4,771 ² |
| 根首个 Turn：status_running → 首个工具结果 | 11,248 / 15,068 / 15,258 | **5,829 / 8,542 / 11,296** |
| 根首个 Turn：首个 tool_use → 结果（含 Sandbox 创建与 Skills 就位） | 9,155 / 10,412 / 10,780 | 4,446 / 5,396 / 6,274 |
| Skills 进入 Sandbox | 每个 Turn（含每个子 Turn）重投影 19 个 Skill、323 个文件；没有单独计时 | 每个根安装一次，p50 953 / p95 1,284 / max 1,770；子 Turn 为 0 |
| 正式服 prod300（#259，10-22） | 146 个子 Session 最新事件停在 `status_running`，最久约 43 分钟；Storage 544 共 87 次 | 本次 0 次 544；子 Turn 准备阶段不读 Skill 存储 |

¹ 最大值来自 run13 的 DP 回修 Turn：首次模型请求在 500 ms 时就已发出，tool_use → 结果也只用了 1.3 s，慢在模型首轮思考，不是准备阶段。子 Turn 到首次模型请求的最大值 4,215 ms 出现在 run23 的 DP（02:55:38Z，正值并发峰值），这个 Turn 同样没有安装。
² run01 和 run12 分别是发布后两个 Runner 进程各自跑的第一个 Turn，到首次模型请求用了 4.8 s 和 4.5 s。其余 29 个根都 ≤ 503 ms。安装发生在首个 tool_use 之后，与这段时间无关。BEFORE 中也有同量级的最大值（4.2 s）。

- **推理不再等待安装（#268）：**
  - 31/31 个根的 `span.model_request_start` 和首个 `agent.tool_use` 都早于 `span.skills_install_start`。冷启动的 Sandbox 在首个 Sandbox 操作时才创建（首个 tool_use 之后 p50 583 ms 开始安装），只有首个工具结果要等安装完成。
  - 在已存在 Sandbox 上换 Skill Set 时（scratch 第 3、4 轮），安装（170–195 ms）与第一次模型请求同时进行。
- **对比口径：**
  - 根首个 Turn 的首个工具结果延迟同时包含 Sandbox 创建或领取，以及 Skills 就位：
    - AFTER 中，首个 tool_use 之后 p50 583 ms（max 1,142 ms）开始安装，说明 Sandbox 此时已经可用；31 个根都没有出现 10-21 那样的创建限流。
    - BEFORE 的 8.3–10.8 s 无法拆分出 Sandbox 创建和 Skills 投影各占多少（10-22 报告记录 Sandbox 在 10–15 s 内可用）。
    - 因此根首个 Turn 的差值不能全部归功于 Skill Bundle。
  - 子 Turn 那一行最能说明改造效果：BEFORE 中子 Turn 先执行 `prepareExisting` 重投影，约 6 s 后才开始推理；AFTER 中跳过安装，0.5 s 内就发出模型请求。而且 AFTER 是在更高并发下测得的。

## 5. `precise-subtitles`：字体、权限、跳过与重装

scratch Agent `agent_lctZXxxYIndpXC6TL_p2F`：
- 从 fixture 复制了 model、thinking、runtime、system 和 sandbox（模板与 env），没有加入任何凭证。
- 装备了 Library Skill `skill_-QRdxY6eN3Nr_mrnbeSkw`，fork 为 `skill_Ew9L_ig5-z_UYOANvw5-V`。
- Session 为 `sess_hHADgjRxSwzPorh3CwTg_`。

| Turn | 之前的变化 | install span | downloaded / bytes / ms | `/skills` 指向（setHash） | Sandbox 内结果 |
|---|---|---|---|---|---|
| 1 | 新 Session | 1 对，installed | 1 / 238,189 / 197 | `9e06b881…3124` | 见下方第 1 轮说明 |
| 2 | 无变化 | **0** | – | `9e06b881…3124` | 输出与第 1 轮相同 |
| 3 | 用 PUT 写 `notes/acceptance.md`，用 multipart 上传 `notes/pixel.png` | 1 对，installed | 1 / 238,618 / 170 | `a262b2e2…5e7e` | 见下方第 3 轮说明 |
| 4 | 编辑器接口：覆盖写、创建后删除 `tmp-delete.txt`、重命名为 `acceptance-renamed.md` | 1 对，installed | 1 / 238,627 / 195 | `6bbfe133…7588` | 见下方第 4 轮说明 |

- **第 1 轮：**
  - 字体 sha256 为 `76d04c18…8ee8`，与官方值一致；头 4 字节为 `00 01 00 00`；大小 410,712 B。
  - `SKILL.md` 为 `root 444`，目录为 `dr-xr-xr-x root`。
  - `touch` 返回 `Permission denied`，运行用户是 `user`。
- **第 3 轮：**
  - `acceptance.md`（113 B）和 `pixel.png`（100 B）都是 `root 444`。
  - PNG 的 sha256 等于上传值 `52f719c8…7069`，字体不变。
- **第 4 轮：**
  - 只剩 `acceptance-renamed.md`，其 sha256 `088c43c0…81a5` 等于编辑器写入的内容。
  - `tmp-delete.txt` 不存在，旧文件名也不存在。

- 三个 setHash 都与按 (name, bundle_sha256) 本地算出的值一致。结束时 scratch 绑定的 `skills_set_hash` 为 `6bbfe133…7588`，且 `skills_sandbox_id = sandbox_id`。
- 编辑只影响 scratch 的 fork：编辑后 fork 指向 bundle `14ba3154…f690`（466,504 B）；Library Skill 和 fixture 的 fork 仍是 `d723ffb7…7faa`（ADR-0004）。
- 第 3 轮中模型省掉了命令里的 `cat acceptance.md`，因为提示里同时要求"不要输出 Skill 正文"。文件的存在、大小和权限已在本轮确认，内容由第 4 轮的 sha256 核对。

## 6. 编辑器接口与 Web 控制台

以下接口都在 scratch Agent 的 fork 上调用，部署的是本次 API。

| 操作 | 结果 |
|---|---|
| 文本读取 `GET files/content?path=notes/acceptance.md` | 200，返回 `content`，sha256 与写入值一致 |
| 文本写入：`PUT files/content` 覆盖后再读回 | 200，读回内容完全一致 |
| 删除：`DELETE files/content?path=notes/tmp-delete.txt` | 200 `skill_file_deleted`；之后再 GET 返回 404 |
| 重命名：`POST files/rename` | 200 `skill_file_renamed`；旧路径 404，新路径内容一致 |
| 二进制上传：`POST files/upload`（multipart，带 `path`） | 200，`skipped: []` |
| `GET files/content` 读取 PNG / TTF | `{binary:true, contentType:"image/png", size:100}` / `{binary:true, contentType:"font/ttf", size:410712}`，没有 `content` 字段 |
| `GET files/raw` 读取 PNG / TTF | 字节与原件完全一致（PNG 与上传的 sha256 相同；TTF 为 `76d04c18…8ee8`，头 `00010000`） |
| `files/raw` 响应头 | `Content-Security-Policy: default-src 'none'; sandbox`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`；默认 `inline`，加 `download=1` 时为 `attachment; filename="pixel.png"` |
| 拒绝的请求 | `.pyc` 写入返回 400 `invalid_skill_file`；`../` 路径返回 400；删除 `SKILL.md` 返回 400 |

**Web 控制台**（browser-harness，在新开的标签页中操作，测试控制台已登录）：
- Agent 页显示 `precise-subtitles` 已装备。打开 Skill 编辑器后，文件树正确显示 13 个文件。
- PNG 预览以 4×4 的 blob 图片渲染。TTF 显示"Not a previewable media type · 401.1 KB · font/ttf · Download"，不会被当成文本打开。
- 文本编辑：Edit → 追加一行 → Save，界面显示"Saved"，API 读回的是新内容。
- 二进制上传：用编辑器的文件输入框上传 `notes/ui-upload.png`（73 B），`files/raw` 返回的字节与本地完全一致（`4b2ce68f…4933`），`files/content` 返回 `binary:true`。

## 7. 存储不在 Turn 路径上

| 检查（运行窗口 02:29Z 起，`kubectl logs --since-time`，另有 observer 每 20 s 的增量） | 结果 |
|---|---|
| Runner 日志 | `pq95k` 5,424 行、`sk7hg` 4,118 行，全部是 `turn_journal_flush` |
| API 日志 | 窗口内 0 行 |
| HTTP 544 / `DatabaseTimeout` / `storage/v1` / `supabase` | 0 / 0 / 0 / 0。字符串"544"出现 59 次，都是 flush 行中时间戳、`bytes` 或 `durationMs` 里的数字 |
| 与 skill 相关的日志、`skills_install`、`sandbox_prepare_failed`、Error、ClaimLost、fence、drain failed、ECONN、timeout | 全部为 0 |
| `session.error`（124 个 Session） | 0；其中 `skills_install_failed` 0，`sandbox_prepare_failed` 0 |
| Runner 重启与就绪 | 0 次重启，69 次采样中没有出现未就绪 |
| 资源峰值 | Runner `pq95k` 1,106 mCPU / 1,464 MiB，`sk7hg` 1,059 mCPU / 1,182 MiB；API 296 mCPU；Redis 378 mCPU |

## 8. #270 验收清单

| 验收项 | 结果 | 证据 |
|---|---|---|
| 多阶段拆分镜任务批量运行（主任务加 Director、DP、Formatter 子任务）时没有 Storage 544，子 Turn 不重复安装 | **通过** | 第 2、3、7 节：31 次运行、124 个 Session；544 为 0；子 Session 的 110 个 Turn 共 0 个 install span；93/93 个子 Session 共用根的绑定 |
| 给出首次安装耗时 p50/p95 和首个模型事件延迟，并与改造前对比 | **通过** | 第 3、4 节：安装 p50 953 / p95 1,284 ms；子 Turn 到首次模型请求 p50 从 6,668 ms 降到 502 ms；根首个工具结果 p50 从 11,248 ms 降到 5,829 ms |
| `precise-subtitles` 的字体在 Sandbox 中有效；编辑器的文本编辑、二进制上传和预览可用 | **通过** | 第 5、6 节：sha256 和 TTF 头正确，root/0444 只读；API 与 Web 控制台都验证过 |
| 验收报告写入 docs/verification | **通过** | 本文件及 JSON |
| PR 已开，CI 全绿 | **不在本次范围** | 本次只提交报告，不 push；由发布负责人处理 |

## 9. 问题与观察

1. **没有发现 Skill Bundle 的缺陷。**
2. **（信息）每个 Runner 进程发布后的第一个 Turn 较慢。**
   - run01 和 run12 从 `status_running` 到首次模型请求用了 4.8 s 和 4.5 s，之后同一进程上的 Turn 只要 0.15–0.5 s。
   - 这与安装无关：安装发生在首个 tool_use 之后。
3. **（信息）峰值并发时 journal flush 变慢。**
   - 峰值时段是 02:55–02:56Z，两个 Runner 上约有 60 个活跃 Session。flush p99 为 330 ms，max 1.19 s，共 9,542 次 flush，没有错误。
   - 10-22 六路并发时 p99 只有 36 ms。这与 Skills 无关，后续评估 Runner/DB 容量时可以参考。
4. **（低，外观问题，未确认是否为新问题）** Web Skill 编辑器预览 `SKILL.md` 时，YAML front matter 被渲染成了一行加粗标题。
5. **（信息，未复现）** 有一次在文本框没有获得焦点时输入，页面跳到了 Session 视图（按键被页面接收）。文本框获得焦点后，编辑和保存都正常。
6. **（未验证）**
   - 带旧版投影 `/skills` 目录的存量 Sandbox 没有测到：测试边界只允许操作本测试创建的 Sandbox，本测试的 Session 也都是新建的。
   - "已存在的 Sandbox 在 Skill Set 变化后的下一个 Turn 自动重装"已在 scratch 第 3、4 轮验证。
7. **环境说明：** `oma_test.delegation_environments` 中原有 232 行 `creation_pending=true`，是历史遗留，与本测试无关。本测试的 31 个根绑定中为 0。

## 10. 清理

- 125 个测试 Session 已全部 terminate（31 个根、93 个子、1 个 scratch）。只读 SQL 确认：这 125 个都是 terminated，全 schema 内 running/waiting 为 0，pending 为 0。
- scratch Agent：Session 已 terminate，fork 已卸下（行已删除），Agent 已删除，GET Agent 和 fork 都返回 404。按设计，bundle 保留，等 #273 统一回收。
- 临时 API key `apikey_nk96z87Mk_mGQf37reVBL` 已吊销，之后的 GET 返回 401。浏览器中为测试打开的标签页已关闭。
- fixture Agent 和 Workspace 没有改动：`updatedAt` 仍是 2026-10-21T04:33:09Z，19 个 Skill 的 bundle 都没变。本次输出只在 `outputs/sk-20261023-NN/` 下。
- Runner 2/2 Ready，0 次重启。没有重启、扩缩或修改任何 Deployment。
