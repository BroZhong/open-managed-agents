# Skill 版本包：正式服发布（#271，2026-10-23）

2026-10-23 11:56–12:01（Asia/Shanghai），经用户授权，把 oma-test 验收过的镜像发布到正式服。用户选择了方案 A：发布与测试服完全相同的镜像 `e2edb6655355`，不夹带验收之后的新提交。

**结论：发布完成，抽查全部通过：**

- 正在运行的根 Session 在交接后，由新 Runner 恢复 Turn，并自动安装 Skill Set：19 个包，1,978,398 字节，1,016 ms，`installed`。
- 随后新建的子 Session 共享同一个 binding，没有安装，也没有 install span。
- 部署之后 `session.error` 为 0；Runner 和 API 日志里没有 Storage 544、`EACCES`、Supabase 相关错误。

数据迁移在发布前已经完成，见 [正式服数据迁移](skill-bundle-migration-production-2026-10-23.md)。发布后的增量处理了 0 个 Skill。

## 变更与回滚

| 组件 | 发布前 | 发布后 |
|---|---|---|
| oma-api（容器 `api`） | `oma-server@sha256:1013cc44…9c04`（`626cf65b3c08`） | `oma-server@sha256:efc57719…7239b`（`e2edb6655355`） |
| oma-runner（容器 `runner`，2 副本） | 同上 | 同上 |
| oma-web（容器 `web`） | `oma-web@sha256:3ffccf37…22f7`（`626cf65b3c08`） | `oma-web@sha256:77236e3c…9976`（`e2edb6655355`） |
| 数据库 | — | schema `oma`：0022（`skills.bundle_sha256`、`bundle_size`），0023（`delegation_environments.skills_sandbox_id`、`skills_set_hash`、`skills_generation`）。均为可空列，旧镜像不读 |
| 配置 | — | 无。正式服沿用"只换镜像"的方式；`WORKSPACE_OSS_INTERNAL_ENDPOINT` 未设置时，代码默认使用区域内网 endpoint `https://oss-cn-shanghai-internal.aliyuncs.com`。仓库里的 manifest 已带上这个变量，正式服的 ConfigMap 里还没有，下次按 rendered manifest 做配置变更时一并补上 |

**回滚：**

- 把三个 Deployment 的镜像改回上表"发布前"一列的 digest。回滚 Runner 时同样先缩到 0。
- 新增的列和 OSS 里的包留着不动，旧镜像不读它们。
- Supabase 里的 Skill 数据原样保留，旧镜像可以直接使用。
- 但回滚后，在新 API 上做的 Skill 修改只存在于版本包里，旧镜像看不到这些修改。

## 步骤与时间（UTC）

1. **冻结编辑：** 发布窗口内没有 Skill 修改。全量迁移的 T0 = 03:24:45.833Z。核对过：T0 减 10 分钟之后，`updated_at` 有更新的 Skill 为 0 个，没有包的 Skill 为 0 个。
2. **API：** 03:56:41 执行 `set image`，03:57:28 rollout 完成，健康检查 `ok`。
3. **Runner：**
   - 03:58:01 缩到 0，03:58:35 旧 Pod 全部退出。
   - 随后换镜像、扩回 2，03:59:22 两个副本都 Ready。
   - 先全停再起，是为了避免新旧 Runner 同时运行：旧 Runner 会以普通用户身份删除 `/skills/<name>`，如果那个 Sandbox 已被新 Runner 切成 root 所有的只读版本，删除会失败，这个 Turn 就以 `sandbox_prepare_failed` 结束。
   - Runner 不可用约 80 s。期间进行中的 Turn 已交出，没有报错。
4. **Web：** 04:00:02 至 04:00:38。
5. **增量迁移：** 04:01:22，`--since 2026-10-23T03:24:45.833Z`，`--manifest` 为全量报告。选中 0 个 Skill，exit 0。运行在新的 API Pod `oma-api-57cddd8b99-5vj7m` 里，工具从提交 `35d793c` 构建。
6. **解冻。**

**Supabase Skill 数据保留期从发布时刻起算：** 2026-10-23T03:56:41Z。14 天后，即 2026-11-06 之后，可以按 #272 拆除。

## 抽查

以下都是部署之后的只读查询，范围是 schema `oma`。

| 检查项 | 结果 |
|---|---|
| 正在运行的 Session 下一个 Turn 自动安装 | 根 Session `sess_PBdStE5thrjE01IT2gmQE` 部署前就在运行。Runner 交接后，新 Runner 先写 `session.turn_resumed`，接着是 `span.skills_install_start` / `_end`：outcome `installed`，19 个 Skill，downloaded 19，1,978,398 字节，1,016 ms。之后模型请求正常继续 |
| binding 记录 | `delegation_environments` 中该 binding 的 `skills_set_hash` 已写入，`skills_sandbox_id` 等于当前 `sandbox_id` |
| 子 Turn 跳过 | 子 Session `sess_6Q4xaixeFw_Yz1dZjzmWY` 在 12:01:46（+08）创建，共享根的 binding。截至 12:04，它已发出 32 次模型请求，install span 0 个，`session.error` 0 个 |
| 没有 Storage 544 | 新的 API 和两个 Runner Pod 的日志里，`544`、`DatabaseTimeout`、Supabase、`EACCES`、`unhandled` 都是 0 次 |
| 错误 | 部署以来 `session.error` 为 0 |
| Pod | API、Runner、Web 都是 Ready，重启次数 0 |

这次抽查的流量很小，只有一棵委派树：1 个根 Session 和它的子 Session。批量负载下的表现见 oma-test 验收：31 次分镜任务，子 Turn 安装 0 次，见 [验收报告](skill-bundles-oma-test-acceptance-2026-10-23.md)。

## 不在这次发布里的提交

正式服运行的镜像不包含 PR #274 上验收之后的两项代码改动：

- `35d793c`：打包时间戳与时区无关。只有进程中途切换时区才会触发，正式服不切换，打包结果不变；
- 竞态小修复：切换成功后即使 Turn 已取消也写回记录。

这两项随下一次发版，先在测试服验证。剩余风险已写进 ADR-0022 的 Consequences。
