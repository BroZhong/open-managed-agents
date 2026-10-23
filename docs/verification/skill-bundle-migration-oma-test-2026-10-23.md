# Skill 版本包迁移：oma-test 的全量、重跑与增量（#266）

2026-10-23 04:43–04:47（Asia/Shanghai）在测试服用 `deploy/scripts/run-skill-bundle-migration.sh` 把 `oma_test` 的全部 Skill 从 Supabase Storage 转成了 OSS 版本包（ADR-0022），依次跑了 dry-run、全量、两次重跑、两次增量。**结论：77 个 Skill 全部写入，`oma_test.skills` 中 `bundle_sha256` 为 NULL 的行数为 0。报告与源数据计数一致；重跑不产生新对象，结果不变；增量只处理 T0 之后更新的 Skill；从 OSS 读回的字体是官方 TTF，任何包里都不再有 `.pyc` 或 `__pycache__`；内容相同的 Library Skill 和 Agent 副本共用一个包。** 只写了 `oma_test.skills` 的两列和 OSS 的 `__oma/skills/<tenantId>/` 前缀，没有修改 `updated_at`，没有改动正式服的 schema `oma`、namespace `oma-infra` 或任何集群资源。

结构化数据见 [JSON](skill-bundle-migration-oma-test-2026-10-23.json)，其中 `fullReport` 是全量运行的完整报告，原样保存，供部署后的增量作为 `--manifest` 使用。

## 给 #270 上线的要点

1. **oma-test 的全量已完成，T0 = `2026-10-22T20:43:54.532Z`**，即全量报告的 `startedAt`。oma-test 现在仍运行旧 API（镜像 `oma-server:395e30e564f0`），在部署 feat/skill-bundles 的 API 和 Runner 之前，旧 API 的编辑仍然写入 Supabase 并推进 `updated_at`。部署完成后要**立即**跑增量（命令见下文）。在增量跑完之前：T0 之后新建的 Skill 没有包；T0 之后被旧 API 改过的 Skill，在新 API 里仍是全量时的版本。如果新 API 在增量之前又改了这样的 Skill，增量会把它判为 `kept` 并保留新 API 的版本，旧 API 在 T0 之后的那次修改不会合入。
2. **T0 的余量由工具自带。** 旧 API 的 `PUT /v1/skills/:id/files/content` 先调用 `skillStore.update` 推进 `updated_at`，再写 Supabase，而且各 Pod 的时钟可能有偏差。如果某次编辑恰好跨过全量开始的时刻，全量可能读到旧内容，而这行的 `updated_at` 又略早于 T0。因此增量选中 `updated_at > since − 10 分钟` 的行，再加上所有 `bundle_sha256` 为 NULL 的行（不论 `updated_at`）；摘要和报告（`deltaMarginMs`、`selectedUpdatedAfter`）会写明实际的选择条件。`--since` 直接用全量的 `startedAt`，不要再自己往前推；晚于 manifest 中最早一次全量 `startedAt` 的值会被拒绝。多选进来的 Skill 重新打包后得到相同的包，状态为 `unchanged`，不会写入。
3. **manifest 决定哪些行归工具管。** 只有两类行会被改写：`bundle_sha256` 为 NULL，或者等于某份 manifest 认领过的值。其他非空的包被视为新 API 发布的版本，原样保留（`kept`），而且不读 Supabase。不带 manifest 重跑时，77 行全部 `kept`，0 次 Supabase 请求。
4. **归属日志（ownership journal）。** 每次真实运行都在报告旁边写 `<report>.journal.jsonl`：先写一行表头，之后每个 Skill 在 PG compare-and-set 写入之前追加一行认领（run id、租户、skill_id、sha256、大小）并 fsync；`unchanged` 的 Skill 也认领。报告只在结束时才写，所以运行中途崩溃时只有日志。wrapper 退出时（包括失败和 Ctrl-C）先把报告和日志拷回本地，再删除 Pod 里的目录；如果工具还在 Pod 里运行，或者拷贝失败，就保留目录。崩溃那次的日志要作为 `--manifest` 传给之后的每次运行，否则它写入的行会一直被判为 `kept`。`--manifest` 既接受报告，也接受日志。
5. **正式服**需要另行授权（#271）：先对 schema `oma` 应用 `deploy/migrations/0022_skill_bundles.sql`，再设置 `OMA_ALLOW_PRODUCTION_MIGRATION=yes` 用 `production` 跑 wrapper（namespace `oma-infra`、schema `oma`、Supabase bucket `workspace`），同样先跑 dry-run。工作区必须没有未提交的修改（`git diff --quiet HEAD`），工具源码路径下也不能有未跟踪的文件；wrapper 会打印构建所用的提交。测试服 1,293 个对象的全量耗时 11.5 s。issue 给出的正式服规模是 351 个 Skill、3,617 个对象，这个数字可能也已过时（见下文对测试服 970 的解释）。
6. **新镜像自带工具之后**，可以在新 Pod 里直接运行源码，不再需要 esbuild：镜像的 WORKDIR 是 `/app/server/packages/api`，API 入口就是 `node --import tsx src/api-server.ts`。字体和 manifest 仍要先用 `kubectl cp` 拷进 Pod，命令见下文。wrapper 与镜像版本无关，任何时候都能用。
7. **退出码：** 0 表示成功，只有警告时也是 0（摘要最后一行是 `Result: success with N warnings (exit 0)`）；2 表示有 Skill `failed` 或 `conflict`，或包校验出问题；1 表示没能开始或中途中断，例如 schema 或 Supabase bucket 与 Pod 的 `PG_SCHEMA`/`S3_BUCKET` 不符、字体不是官方文件、缺少 0022 列、`--since` 晚于最早一次全量的开始时间、日志文件已存在。**字体：** 所有损坏的 `LiberationSans-Regular.ttf` 换成官方文件；其他损坏的字体照原样发布（它本来就是坏的，阻塞整个 Skill 更糟），记为警告，不影响退出码。
8. 运行时 stderr 会出现一行 `pg` 的 `DeprecationWarning`（`client.query()` 并发调用），来源是 `createPgPool` 在 `connect` 事件里不等待地执行 `SET search_path`，和本工具无关，也无害。
9. 测试服与正式服共用 bucket `agentry`，key 里不带环境。本次在两个测试租户下写入了 20 个对象（`cee644c5…` 下 1 个，`f00c7d5a…` 下 19 个）。#273 做回收时需要考虑这一点。

## 方法

- **工具：** 分支 `wt/266-bundle-migration`，提交 `37e69c3`（已合并 `feat/skill-bundles` 的最新提交 `847b2f6`）。工具自带一个只读的 Supabase 读取器 `supabase-reader.ts`，不依赖已删除的 `store/src/s3/*`。wrapper 用 esbuild 打包 `server/packages/api/src/migrate-skill-bundles.ts`，连同字体和 manifest 拷进 oma-test 的 API Pod（`oma-api-976cfcb59-whwkg`）里新建的临时目录，用 Pod 的 `PG_*`、`S3_*`、`WORKSPACE_OSS_*` 环境运行，取回 JSON 报告后删除临时目录。每个 kubectl 调用都带 `--request-timeout`，本机另用 `perl -e 'alarm …'` 限制 wrapper 的总时长。运行结束后 Pod 的 `/tmp` 下没有残留目录，也没有残留进程。
- **字体：** 官方 liberation-fonts 2.1.5 发布包 `liberation-fonts-ttf-2.1.5.tar.gz`，sha256 `7191c669…25d0`。从中取出 `LiberationSans-Regular.ttf`：410,712 字节，sha256 `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8`。工具只接受这个 sha256。
- **源数据对账：** 通过 Supabase SQL 只读查询 `oma_test.skills`，以及 `storage.objects` 中 `bucket_id='workspace-test'` 且 `split_part(name,'/',2)='skills'` 的对象。
- **PG 指纹：** 对 `(tenant_id/skill_id@updated_at)` 和 `(tenant_id/skill_id=bundle_sha256:bundle_size)` 拼接后取 md5，按 `tenant_id, skill_id COLLATE "C"` 排序。分别在全量之前、全量之后、所有运行之后各取一次，并与报告按同样规则算出的指纹比较。
- **OSS 读回：** 用一个临时的只读脚本（未提交），打包后在同一个 Pod 里运行：用 ali-oss `listV2` 列出 `__oma/skills/<tenantId>/`，用 `OSSSkillBundleStore.readAll`（`cacheBytes: 0`；下载时校验对象内容的 sha256 与 key 一致）解开全部 20 个包，统计文件、`.pyc`/`__pycache__` 条目，以及每个字体的 sha256 和前 4 个字节。脚本只输出 key 中的 sha256、大小和 lastModified，不输出 URL、凭证或文件内容。分别在全量之前、全量之后、两次重跑之后各运行一次。

## 结果

### 源数据

| 项目 | 值 |
|---|---|
| Skill 行 | 77（Library 20，Agent 57；57 个 Agent 副本都带 `source_skill_id`，源行都存在），分属 2 个租户 |
| Supabase 对象 | 1,293 个，20,143,894 字节，分布在 77 个 Skill 前缀下 |
| 其中 `.pyc` / `__pycache__` | 32 个（`vfs` 每份 6 个，`script-to-dp` 每份 2 个，各 4 份） |
| 其中字体 | 4 个，即 4 份 `precise-subtitles` 的 `assets/fonts/LiberationSans-Regular.ttf`，每份 544,485 字节，sha256 `fd0a22f2…`，`FFTM` 表越界 |
| `updated_at` 范围 | 2026-10-14 17:28:53.847 至 2026-10-22 14:30:26.425（+08） |

**为什么 issue 写的是 970 个对象。** 按创建时间统计，对象分四批：10-14 17 时 1 个；10-21 12 时 646 个（38 个 Skill）；10-22 02 时 323 个（19 个 Agent 副本）；10-22 14 时 323 个（又 19 个 Agent 副本）。970 = 1 + 646 + 323，正好是第四批创建之前的对象数，而那时只有 58 个 Skill。issue 里的 77 个 Skill 和 970 个对象取自不同时刻；现在的源数据是 77 个 Skill、1,293 个对象，与两次 dry-run 和全量报告完全一致。

### 各次运行

| 运行 | 开始（UTC） | 选中 | 状态 | Supabase 对象 / 字节 | 请求 / 重试 | 不同的包 | 上传 | 校验 |
|---|---|---|---|---|---|---|---|---|
| dry-run | 20:43:23.399 | 77 | would-write 77 | 1,293 / 20,143,894 | 1,578 / 0 | 20 | 0 | 内存中 20 个包，0 个问题 |
| **全量** | **20:43:54.532** | 77 | **written 77** | 1,293 / 20,143,894 | 1,578 / 0 | 20 | **20 个，1,978,576 字节** | OSS 读回 20 个包，0 个问题 |
| 重跑，带全量 manifest | 20:45:42.315 | 77 | **unchanged 77** | 1,293 / 20,143,894 | 1,578 / 0 | 20 | **0** | OSS 读回 20 个包，0 个问题 |
| 重跑，不带 manifest | 20:46:05.714 | 77 | kept 77 | 0 / 0 | 0 / 0 | 0 | 0 | — |
| **增量**，`--since 2026-10-22T06:30:20.000Z` | 20:46:45.785 | **8** | unchanged 8 | 169 / 1,913,609 | 202 / 0 | 8 | 0 | OSS 读回 8 个包，0 个问题 |
| 增量，manifest 中 1 行被改动 | 20:47:01.489 | 8 | unchanged 7，**kept 1** | 163 / 1,883,829 | 194 / 0 | 7 | 0 | OSS 读回 7 个包，0 个问题 |

另外，前一位工程师在 02:24 用合并前的代码跑过一次 dry-run，77 个 Skill 得到的包与本次 dry-run 和全量逐一相同。

### 全量

- 77 个 Skill 全部 `written`。20 个不同的包，其中 19 个各由 1 个 Library Skill 和它的 3 个 Agent 副本共用，1 个属于另一租户的 `e2e-probe`。全部包共 316 个文件、4,820,793 字节（未压缩）；按 Skill 计共 1,261 个文件。
- 过滤掉 32 个 `.pyc`/`__pycache__` 文件；替换了 4 个字体，从 544,485 字节的损坏文件换成 410,712 字节的官方文件；没有未替换的损坏字体。
- **PG：** 全量之后 `bundle_sha256` 和 `bundle_size` 为 NULL 的行都是 0，不同的包有 20 个。包指纹 `64328166…c6c6` 与报告算出的值相同，说明每一行的 sha256 和大小都与报告一致。`updated_at` 指纹 `f34fab38…9e23e9c` 与全量之前相同（毫秒精度的指纹 `f765729e…5fae74` 也与报告中各行的 `updatedAt` 一致），所以 `updated_at` 没有被修改。
- **OSS：** 全量之前，两个租户的前缀下都是 0 个对象；全量之后共 20 个对象，`cee644c5…` 下 1 个（178 字节），`f00c7d5a…` 下 19 个（1,978,398 字节）。列出的 key 集合与报告中的包完全相同，每个对象的大小等于报告里的 `zipBytes`。

### 幂等

- 带全量报告作为 manifest 重跑：77 个 Skill 全部 `unchanged`，上传 0 个。逐个 Skill 比较，包的 sha256、大小、文件数、zip 字节数、过滤列表和字体替换都与全量相同；`verification`（包括读回的字体列表）、`sharedBundles`、`forks` 也完全相同。每行的 `previousBundleSha256` 都等于全量写入的值。
- 不带 manifest 重跑：77 行全部 `kept`，没有读 Supabase，也没有写任何东西。
- 两次重跑之后，OSS 的列表（key、大小、lastModified）与全量之后完全一致，lastModified 都还在 20:43:54–20:44:02 之间。PG 的包指纹和 `updated_at` 指纹都没有变。

### 增量

- 测试服在全量之后没有 Skill 被修改，所以 T0 取在数据范围之内：`2026-10-22T06:30:20.000Z`，也就是最后一批 19 个 Agent 副本的创建时间段中间。PG 中 `updated_at > T0` 的行正好 8 个。增量选中的也是这 8 个（`updated_at` 从 06:30:20.043Z 到 06:30:26.425Z），其余 69 个没有被读取。8 个都是 `unchanged`，没有写入。
- **manifest 与行不一致时跳过：** 把全量报告复制一份，将 `skill_U_PDsGu4t8BEU4B_7tLiQ`（byted-mediakit-audio）记录的包改成 `e…e`（64 个 e），再作为 manifest 跑同一个增量。这一行实际的包 `2cfa6994…` 与 manifest 不符，所以被判为 `kept`，原因是 "bundle changed since the manifest: published by another writer (the new API)"。它的 6 个对象没有被读取（169 − 163），行也没有被修改。这模拟的是新 API 在增量之前发布了新版本的情况，没有改动任何测试数据。
- 单元测试覆盖了其余几种情况，见 `server/packages/api/test/skill-bundle-migration.test.ts`：
  - "delta processes only Skills updated after T0 and never overwrites a bundle the new API wrote"：T0 之后被编辑的副本和新建的 Skill 被写入；新 API 已发布的包被保留；`updated_at` 没有推进的 Skill 不在增量范围内；用两份报告作为 manifest 再跑一次，结果全部 `unchanged`。
  - "reports a compare-and-set lost to a concurrent edit as a conflict and keeps the other writer's bundle"：选中之后、`UPDATE … WHERE bundle_sha256 = <旧值>` 之前，若行被别人改了，则报告 `conflict`，保留对方的包。
  - "guards the delta: it needs the full run's report and a T0 no later than that run's start"。

### 从 OSS 读回

| 检查项 | 结果 |
|---|---|
| 包 | 20 个都存在，下载内容的 sha256 与 key 一致；每个包都有 `SKILL.md`；文件数与报告的 `bundleFiles` 一致（共 316 个） |
| `.pyc` / `__pycache__` | 20 个包里都是 0 个条目 |
| `precise-subtitles` 的字体 | 包 `d723ffb7c75a2b4fac5edea61648c8bce80bab237b74968c88058354e6b37faa` 里的 `assets/fonts/LiberationSans-Regular.ttf`：410,712 字节，前 4 个字节为 `00 01 00 00`，sha256 `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8`，与官方文件相同。工具自己的读回校验同样认定它是有效字体：table directory 和 `head` 表的魔数都正确 |
| 共用包 | PG 中 57 个 Agent 副本与各自的源 Library Skill 有相同的 `bundle_sha256` 和 `bundle_size`；4 行 `precise-subtitles`（1 个 Library Skill、3 个副本）都指向同一个包 `d723ffb7…` |

## 命令

所有命令都在 worktree 根目录执行。wrapper 固定使用 `~/.kube/agent-platform-config`，可以用 `OMA_KUBECONFIG` 覆盖，但不会使用环境里的 `KUBECONFIG`。

准备字体（一次即可）：

```bash
curl -fsSLO https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz
shasum -a 256 liberation-fonts-ttf-2.1.5.tar.gz   # 7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0
tar -xzf liberation-fonts-ttf-2.1.5.tar.gz liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf
export OMA_FONT=$PWD/liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf
```

各模式（与本次的运行相同，报告路径换成了本地临时目录；本地已有的报告或日志不会被覆盖，每次换一个报告路径）：

```bash
# dry-run：读取、修复、打包，在内存中校验，不写入任何东西（应用 0022 之前也能跑）。
# 不带 manifest 时，已有包的行都是 kept；带上 manifest 才会与已写入的包比较
deploy/scripts/run-skill-bundle-migration.sh test dry-run.json --dry-run --manifest full.json 2> dry-run.log
# 全量：需要先应用 0022。T0 = full.json 的 startedAt；归属日志在 full.journal.jsonl
deploy/scripts/run-skill-bundle-migration.sh test full.json 2> full.log
# 重跑（幂等检查）：把之前的非 dry-run 报告（或崩溃那次的日志）都作为 manifest 传入
deploy/scripts/run-skill-bundle-migration.sh test rerun.json --manifest full.json 2> rerun.log
# 增量：处理 updated_at > --since − 10 分钟的 Skill，以及没有包的 Skill；--since 直接用 T0
deploy/scripts/run-skill-bundle-migration.sh test delta.json --since 2026-10-22T20:43:54.532Z --manifest full.json 2> delta.log
```

wrapper 在 Pod 里实际执行的命令（`<dir>` 是 `/tmp/oma-skill-bundle-migration-<epoch>-<pid>`；真实运行的日志在 `<dir>/report.journal.jsonl`）：

```bash
node <dir>/migrate-skill-bundles.mjs --schema oma_test --supabase-bucket workspace-test \
  --font <dir>/LiberationSans-Regular.ttf --report <dir>/report.json \
  [--dry-run] [--since <T0>] [--manifest <dir>/manifest-1 ...]
```

**oma-test 部署之后的增量**（#270）。从本次的 JSON 取出全量报告作为 manifest，`--since` 就用 T0 本身（10 分钟余量由工具自带）：

```bash
jq '.fullReport' docs/verification/skill-bundle-migration-oma-test-2026-10-23.json > full.json
deploy/scripts/run-skill-bundle-migration.sh test delta.json \
  --since 2026-10-22T20:43:54.532Z --manifest full.json 2> delta.log
```

如果部署之前在 T0' 又跑了一次全量（带 `--manifest full.json`，结果会收敛），就把那次的报告也作为 manifest 加在后面；`--since` 不能晚于最早一次全量的开始时间，所以仍用 T0。任何一次运行崩溃了，都把它的 `.journal.jsonl` 加进之后每次运行的 manifest。

**镜像自带工具之后**，也可以不经过 esbuild，直接在新 Pod 里运行（选一个 Running、Ready 且不在终止中的 Pod）：

```bash
export KUBECONFIG=~/.kube/agent-platform-config
pod=$(kubectl --request-timeout=30s -n oma-test get pod -l app=oma-api -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' |
  awk -F'\t' '$2 == "Running" && $3 == "" && $4 == "True" { print $1; exit }')
kubectl --request-timeout=30s -n oma-test exec "$pod" -- mkdir /tmp/m266
kubectl --request-timeout=30s -n oma-test cp "$OMA_FONT" "$pod:/tmp/m266/LiberationSans-Regular.ttf"
kubectl --request-timeout=30s -n oma-test cp full.json "$pod:/tmp/m266/full.json"
kubectl --request-timeout=30s -n oma-test exec "$pod" -- node --import tsx src/migrate-skill-bundles.ts \
  --schema oma_test --supabase-bucket workspace-test --font /tmp/m266/LiberationSans-Regular.ttf --report /tmp/m266/delta.json \
  --since 2026-10-22T20:43:54.532Z --manifest /tmp/m266/full.json
# 无论成功与否，都先取回报告和日志，再删除目录
kubectl --request-timeout=30s -n oma-test cp "$pod:/tmp/m266/delta.json" delta.json
kubectl --request-timeout=30s -n oma-test cp "$pod:/tmp/m266/delta.journal.jsonl" delta.journal.jsonl
kubectl --request-timeout=30s -n oma-test exec "$pod" -- rm -rf /tmp/m266
```

只读的 PG 检查（在 Supabase SQL 中执行）：

```sql
SELECT count(*) AS skills,
       count(*) FILTER (WHERE bundle_sha256 IS NULL) AS null_bundle_sha256,
       count(*) FILTER (WHERE updated_at > '<T0>') AS updated_after_t0
FROM oma_test.skills;
```

## 验收对照

| 验收标准 | 结果 |
|---|---|
| 在 oma_test 上试跑，报告与源数据计数一致 | dry-run 和全量都是 77 个 Skill、1,293 个对象、20,143,894 字节，与 `oma_test.skills` 和 `storage.objects` 的独立计数一致；PG 中每行的包与报告一致 |
| 重复运行不产生新对象，结果不变 | 77 个 `unchanged`，上传 0 个；OSS 列表和 PG 指纹都不变；逐个 Skill 的结果与全量相同 |
| 增量只处理 T0 之后更新的 Skill | 8 / 77，正好是 `updated_at > T0` 的行；manifest 不符的行被 `kept`；compare-and-set 由单元测试覆盖。评审修复之后，增量还会选中 T0 之前 10 分钟内更新的行和没有包的行，见下文 |
| 字体是有效 TTF，`.pyc` 不再存在 | 从 OSS 读回：文件头 `00 01 00 00`，sha256 与官方一致；20 个包里没有 `.pyc` 或 `__pycache__` 条目 |
| 内容相同的 Library Skill 与 Agent 副本得到同一个包 | 57 / 57 个副本与源 Skill 共用包；`precise-subtitles` 的 4 行只有 1 个包 |
| 不打印凭证或签名 URL | 所有报告、摘要和日志中都没有出现 `Signature`、`x-oss-`、`Bearer`、`eyJ`、`LTAI`、`password` 或任何 URL。本 JSON 中唯一的 URL 是公开的字体发布包地址 |

## 评审修复之后（2026-10-23）

代码评审之后修复了以下问题（提交 `69cd7a9` 至 `6ae989e`），并用修复后的工具在 oma-test 上重新验证。

1. 复用 `@oma-server/store` 的 `isFilteredSkillPath`、`assertSkillBundleIdentity` 和 `SkillOwnerType`；命令行改用 `node:util` 的 `parseArgs`（strict，`--manifest` 可重复）；只保留一个并发限制器。
2. 工具自己组织的错误信息照常输出。其他错误（ali-oss、urllib、pg）只保留名称、code 和 HTTP 状态，所以报告、摘要和 stderr 里不会再出现请求 URL 或 `raw xml`。
3. 增量自带 10 分钟余量，并且总会选中 `bundle_sha256` 为 NULL 的行；`--since` 与 manifest 中最早一次全量的 `startedAt` 比较（见要点 2）。
4. 归属日志，以及 wrapper 在退出 trap 里拷回报告和日志（见要点 4）。wrapper 改为选择 Running、Ready 且没有 `deletionTimestamp` 的 Pod，并且先创建本地目录，再 `tee` 摘要。
5. 字体警告和退出码（见要点 7）。
6. 正式服的保护（见要点 5）。CLI 参数 `--bucket` 改名为 `--supabase-bucket`；去掉了 `SUPABASE_STORAGE_URL`/`S3_SERVICE_KEY` 回退，Pod 只设置 `S3_ENDPOINT` 和 `SUPABASE_SERVICE_KEY`。esbuild 改为从 `@oma-server/api` 的 devDependency `tsx` 所声明的依赖解析：`pnpm --dir server exec esbuild` 找不到它，因为没有 workspace 包直接声明 esbuild。

**重新验证**：通过 wrapper 运行（提交 `37d419e`、`6ae989e`，工作区干净），Pod `oma-api-976cfcb59-whwkg`，镜像仍是旧 API `395e30e564f0`。

| 运行 | 开始（UTC，10-23） | 选中 | 状态 | Supabase 对象 / 字节 | 上传 | PG 写入 | 退出码 |
|---|---|---|---|---|---|---|---|
| dry-run，`--manifest full.json` | 01:26:54.902 | 77 | unchanged 77 | 1,293 / 20,143,894 | 0 | 0 | 0 |
| 增量，`--since 2026-10-22T20:43:54.532Z`（T0 本身） | 01:27:57.107 | 0 | — | 0 / 0 | 0 | 0 | 0 |
| 增量，`--since 2026-10-22T06:40:20.000Z`（检验余量） | 01:28:16.520 | 8 | unchanged 8 | 169 / 1,913,609 | 0 | 0 | 0 |
| 增量，`--since 2026-10-22T20:43:54.533Z` | — | — | 被拒绝：晚于全量开始 1 ms | — | — | — | 1 |

- **dry-run 与全量结果相同：** 77 个 Skill 的包 sha256、大小、文件数、zip 字节数、对象数、字节数、过滤列表和字体替换都与全量报告逐一相同；`verification`（`source` 字段除外，dry-run 为 `packed`）、`sharedBundles`、`forks` 也相同。
- **T0 增量：** 选择条件是 `updated_at > 2026-10-22T20:33:54.532Z` 或没有包，PG 中没有这样的行，所以什么也没读、没写。本地留下了只有表头的 `delta-t0.journal.jsonl`。
- **余量：** `06:40:20` 减去 10 分钟正好是上次增量用的 `06:30:20`。选中的是同样的 8 行（对象数、字节数和 202 次请求都与上次相同），都是 `unchanged`，包与全量相同。日志是表头加 8 行认领，sha256 与全量一致；报告里这 8 个 Skill 都是 `claimed: true`。
- **PG**（只读 SQL，只查 `oma_test`）：运行前后都是 77 行，`bundle_sha256` 和 `bundle_size` 为 NULL 的行都是 0，不同的包 20 个。包指纹 `64328166…c6c6` 前后不变，与全量报告按同样规则算出的值相同。`updated_at` 指纹前后都是 `b96bb227…4864`（本次按 SQL 会话的时区格式化，所以与上文的值不同）。
- **Pod：** 运行后 `/tmp` 下没有 `oma-skill-bundle-migration-*` 目录，也没有残留的 node 进程。报告、摘要、日志文件和 stderr 中都没有 URL、`Signature`、`x-oss-`、`Bearer`、`eyJ`、`LTAI` 或 `password`。
- **测试：** `server/packages/api/test/skill-bundle-migration*.test.ts` 共 49 个测试通过。新增的测试覆盖 `main()` 的退出码 0/2/1、`--schema`/`--supabase-bucket` 与 `PG_SCHEMA`/`S3_BUCKET` 的校验、运行中途崩溃留下的日志被下一次运行当作 manifest 使用、多份全量报告下的 `--since` 检查、错误信息脱敏、增量选中没有包的行，以及字体警告。
