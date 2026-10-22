# 本地并发读取 Skill Storage：复现 HTTP 544

2026-10-22 02:32–02:38（Asia/Shanghai），从本机直接并发读取测试 Agent 的 Skill Storage，**两次文件 GET 均复现与 Sandbox 日志相同的 HTTP 544 `DatabaseTimeout`**。本次没有发起 OMA 任务，没有创建 Session 或 Sandbox，也没有修改数据库、Storage 配置或运行时代码。

## 范围与方法

- 固定测试 bucket `workspace-test`，测试 Agent `agent_tdpcn95CKCCQzEAa5SBGz`，只访问该 Agent 所属 tenant 的 19 个 Skill。
- GET 轮询读取这 19 个 Skill 的 `SKILL.md`；LIST 只查询各 Skill 的目录。1,600 是重复请求总数，不是 1,600 个不同 Skill。
- 本地无法连接 Runner 使用的 VPC 地址，因此使用已核对为同一 Supabase 实例的公网 HTTP Storage endpoint。实例为 `ra-lvyt8wkxiid4a76`，对应 RDS `pgm-uf6fh394661t62gb`。此路径与原 Sandbox 测试的网络路径不同；bucket 是测试范围，数据库基础设施仍然共享。
- Python / aiohttp 3.9.3；无自动重试，禁止重定向，HTTP 连接池上限与配置并发一致，完整读取响应体。成功 GET 对照基线内容 SHA-256；LIST 校验 JSON 及 `SKILL.md` 条目。没有保存 Skill 正文或认证头。
- 从 8、20、40、80、160、200、400 逐档到 800 并发；每档计划发送两倍并发数的请求。出现首个错误即停止派发新请求，等待已发出的请求结束。首次错误后停止升档，没有执行 1,600 并发。

## 请求结果

| 操作 | 实测峰值在途请求 | 实际请求 | HTTP 200 | HTTP 544 | 错误率 | 总延迟 p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| GET | 200 | 400 | 400 | 0 | 0% | 1.40 / 1.68 s |
| GET | 400 | 800 | 800 | 0 | 0% | 2.67 / 7.16 s |
| GET 首次 | 800 | 1,600 | 1,521 | 79 | 4.94% | 4.89 / 9.42 s |
| GET 复验 | 800 | 1,175 | 984 | 191 | 16.26% | 4.48 / 6.73 s |
| LIST 对照 | 800 | 1,600 | 1,600 | 0 | 0% | 1.00 / 6.41 s |

GET 复验原计划 1,600 次，首次错误后剩余 425 次没有发送，错误率分母为实际完成的 1,175 次。全部 22 个批次共完成 8,084 次请求，7,814 次 HTTP 200、270 次 HTTP 544；没有客户端连接错误、内容校验错误或重试。较低并发各档均成功，但这些短批次不能证明长期稳定容量，也不能确定精确故障阈值。

270 次错误均返回与原故障相同的固定内容：

```json
{"statusCode":"544","code":"DatabaseTimeout","error":"DatabaseTimeout","message":"The connection to the database timed out"}
```

两次 GET 800 的实测 HTTP 在途峰值均为 800，客户端连接池排队时间为 0；事件循环延迟 p95 分别为 2.93 / 2.48 ms，客户端 CPU 约占单核 11% / 12%。错误响应体读取 p95 仅 0.07 / 0.13 ms。因此，本轮确实收到远端 HTTP 544，并非本地请求超时或没有达到配置并发。400 并发批次出现过约 1.7–1.95 s 的客户端事件循环停顿，不能把整个矩阵当成无客户端干扰的容量基准。

800 表示同时在途 HTTP 数，不是 800 QPS。两次 GET 全批平均完成速率约 130 / 135 次每秒，是排队、超时及早停共同作用后的结果，不是受控的请求到达速率。

## 同步数据库观察

通过只读 `pg_stat_activity` 采样；GET 两轮约每 2 秒一帧，LIST 每秒一帧。只保存聚合状态和固定 SQL 类别，不保存 SQL 原文或参数。

| 批次 | 窗口内样本 | 全库连接数采样峰值 | Storage 连接峰值 | Storage idle-in-transaction 峰值 | Storage Lock wait / 被阻塞连接 |
|---|---:|---:|---:|---:|---:|
| GET 首次 | 6 | 93 | 21 | 18 | 0 / 0 |
| GET 复验 | 4 | 91 | 21 | 18 | 0 / 0 |
| LIST 对照 | 7 | 91 | 21 | 19 | 0 / 0 |

GET 负载窗口的采样中，多数 Storage 连接处于 `idle in transaction / ClientRead`：数据库正在等待 Storage 客户端后续命令。它们不是数据库锁等待。两轮 544 响应分别集中在约 0.50 / 0.39 s 内，2 秒数据库采样没有命中这两个精确响应窗口，因此只能建立负载窗口的相关性。21 是观测到的连接数，**不能直接认定实际池上限就是 20 或 21**。

尤其需要避免把 `idle in transaction` 数量直接解释为连接泄漏：LIST 全成功时同样观察到 19 个这种状态，其事务年龄采样最大只有 0.129 s，处于该状态的年龄最大 0.068 s；最后执行的命令类别为 BEGIN、SET_CONTEXT 或 SEARCH。GET 两轮没有采事务年龄，不能据状态数量推断事务持续数秒。三个批次结束后均回到普通 idle，采样没有显示持续未结束事务。

结合此前确认的 PG 一般连接额度 3,200，当前连接样本不支持“PG 全库连接耗尽”。1–2 秒采样仍可能漏掉短峰值；没有取得 Storage 进程内部的池上限、连接获取队列、事件循环指标或原始异常日志，不能据此唯一确定根因，也不能套用前一轮压测的 CPU 指标作为本轮 CPU 证据。

## 可得出的结论与边界

1. **问题可在脱离 Runner、Sandbox、模型调用和 Skill 投影重试后复现。** 直接读取 Storage 就能触发相同 544，后续定位可以使用这个更小的复现环境。同样的错误码和文案并不证明与之前 Runner 故障的内部根因完全相同。
2. 同档 LIST 本次成功，GET 两次失败，说明两条路径在本轮的表现存在差异；LIST 的 p95 仍达到 6.41 s，不能宣称 LIST 没有压力或在真实混合流量中一定安全。
3. 应优先检查 Storage GET 路径的连接获取与事务调度，以及托管 Storage 服务自身资源。当前证据不足以区分局部池限制、连接持有/释放问题、服务调度问题或其他被映射为 544 的数据库超时；不支持直接把 PG `max_connections` 当作修复开关。

本次目标为复现，没有实施修复，故不宣称故障已消除。结束时分别串行读取 19 个 Skill 文件和 19 个目录，全部成功，GET p50 29.3 ms、LIST p50 12.15 ms。所有并发请求及数据库观察已停止，临时 Storage 凭证文件已删除；没有向正式服发起任务。

汇总、各批次指标、数据库窗口和源文件 SHA-256 见 [JSON 证据](/Users/zhangyuzhong/github/open-managed-agents/docs/verification/skill-storage-local-concurrency-2026-10-22.json)。临时复现脚本及无正文的逐请求记录位于 `/private/tmp/oma-skill-read-repro-20261022`，该目录不保证长期保存。脚本读取的临时鉴权文件已移除，不能直接重复执行而意外再次发起负载。原始 200 路 storyboard 测试见[前一轮报告](/Users/zhangyuzhong/github/open-managed-agents/docs/verification/storyboard-real-vfs-200-2026-10-22.md)。
