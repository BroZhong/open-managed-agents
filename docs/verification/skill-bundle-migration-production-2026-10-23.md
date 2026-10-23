# Skill 版本包迁移：正式服全量（#266，#271 的数据部分）

2026-10-23 11:2x（Asia/Shanghai），经用户授权，先在正式服做了 Skill 的数据迁移，没有更换镜像。具体做了三件事：

1. 对 schema `oma` 应用了 0022 和 0023；
2. 用 `deploy/scripts/run-skill-bundle-migration.sh production` 先跑 dry-run，再跑全量；
3. 把全部 Skill 从 Supabase Storage 转成 OSS 版本包（ADR-0022）。

**结论：351 个 Skill 全部写入，`oma.skills` 中没有包的行为 0。报告与源数据计数一致。104 个包从 OSS 读回校验，0 个问题。3 份 `precise-subtitles` 的坏字体换成了官方 LiberationSans，读回的 TTF 文件头正确。144 个 `.pyc` / `__pycache__` 文件已去掉。**

本次只写了三处：`oma.skills` 的两列、`oma.delegation_environments` 新增的三列（迁移本身），以及 OSS 的 `__oma/skills/<tenantId>/` 前缀。没有修改任何行的 `updated_at`。正式服的 API、Runner、Web 仍是 `626cf65b3c08`，旧代码不读这些新列，运行不受影响。

结构化数据见 [JSON](skill-bundle-migration-production-2026-10-23.json)。其中 `fullReport` 是全量报告原文，部署新镜像后跑增量时用作 `--manifest`。

## 部署新镜像时必须做的事

1. **T0 = `2026-10-23T03:24:45.833Z`**，即全量报告的 `startedAt`。
2. 在部署 feat/skill-bundles 的 API 和 Runner 之前，旧 API 的 Skill 编辑仍然只写 Supabase。部署完成后要**立即**跑增量。工具会自动把选择范围往前放宽 10 分钟，并且不论 `updated_at`，都会选中所有还没有包的行。

   ```bash
   jq '.fullReport' docs/verification/skill-bundle-migration-production-2026-10-23.json > full.json
   OMA_ALLOW_PRODUCTION_MIGRATION=yes OMA_FONT=/path/to/LiberationSans-Regular.ttf \
     deploy/scripts/run-skill-bundle-migration.sh production delta.json \
     --since 2026-10-23T03:24:45.833Z --manifest full.json 2> delta.log
   ```

3. 部署时 Runner 要先全部停掉再起新的：先缩到 0，换镜像，再扩回 2。滚动更新期间，旧 Runner 会以普通用户身份删除 `/skills/<name>`。如果那个 Sandbox 已被新 Runner 切成 root 所有的只读版本，删除会失败，这个 Turn 就以 `sandbox_prepare_failed` 结束。先全停再起，进行中的 Turn 会先交出、排队，等新 Runner 起来后接着做。
4. Web 最后部署。Web 先换的话，新的二进制预览和上传接口在旧 API 上不存在，会报 404。
5. 正式服 Sandbox 镜像 `oma-sandbox@sha256:67a46af6…` 已核对，安装脚本需要的 bash、curl、unzip、flock、coreutils 都在，版本和 #261 spike 一致。

## 方法

- **工具：** 提交 `96548a2`（feat/skill-bundles）。wrapper 检查工作区干净后，构建工具，拷进 API Pod `oma-infra/oma-api-7d6b6c6f56-8tn2l` 的临时目录，用 Pod 的 `PG_*`、`S3_*`、`WORKSPACE_OSS_*` 环境运行，取回报告和归属日志后删除临时目录。本机另用 `perl -e 'alarm …'` 限制 wrapper 的总时长。
- **字体：** 官方 liberation-fonts 2.1.5 的 `LiberationSans-Regular.ttf`，410,712 字节，sha256 `76d04c18…8ee8`。工具只接受这个文件。
- **迁移 0022 / 0023：** 通过 Supabase MCP `execute_sql` 执行，在 dry-run 之前完成。RPC 路径内整条调用是原子的，因此去掉了显式的 `BEGIN`/`COMMIT`。执行前确认 `oma_app` 对两张表有表级 SELECT、INSERT、UPDATE 权限，对新列同样生效。
- **对账：** 用只读 SQL 查询 `oma.skills`，以及 `storage.objects` 中 `bucket_id='workspace'` 且 `split_part(name,'/',2)='skills'` 的对象。

## 结果

| 项目 | 迁移前 | dry-run | 全量 |
|---|---|---|---|
| Skill | 351（5 个租户；Library 57，Agent 294） | 351 would-write，0 failed | 351 written，0 failed / conflict |
| Supabase 对象 / 字节 | 3,617 / 44,975,453 | 3,617 / 44,975,453，0 次重试 | 同左 |
| 包（租户 + sha） | — | 104 | 上传 104 个，zip 共 6,497,547 字节 |
| `.pyc` / `__pycache__` | — | 过滤 144 个 | 同左 |
| 字体 | 3 份 `precise-subtitles` 的 `LiberationSans-Regular.ttf`：544,485 字节，sha256 `fd0a22f2…`，`FFTM` 表越界 | 替换 3 份 | 替换 3 份；读回 sha256 `76d04c18…`，文件头 `00 01 00 00` |
| 包校验 | — | 对打包结果校验，0 个问题 | 从 OSS 读回校验，104 个包，0 个问题 |
| 耗时 | — | 35 s | 30 s |

dry-run 与全量的逐 Skill 包 sha256 完全一致（351/351）。

全量之后的只读 SQL 核对结果：

- 351 行全部有 `bundle_sha256` 和 `bundle_size`；
- 不同的（租户, sha256）组合有 104 个，与上传对象数一致；不同的 sha256 有 99 个，因为有 5 个包在多个租户下内容相同；
- 161 个 Agent 副本与其 Library 来源共用一个包，另有 68 个副本在装备后被编辑过；
- 3 份 `precise-subtitles` 共用 1 个包；
- 最新的 `updated_at` 仍是 2026-10-21 07:53:52.672Z，迁移没有推进任何行的 `updated_at`。

迁移期间正式服没有运行中的 Session。迁移前后 API 健康检查都正常，API 和 Runner 的重启次数为 0，Pod 里没有残留的临时目录。

## 注意

- 测试服与正式服共用 bucket `agentry`，key 里不带环境。#273 做回收时，要同时考虑两边对包的引用。
- 报告和日志里没有 URL、凭证或文件内容，wrapper 的输出也逐项检查过。
