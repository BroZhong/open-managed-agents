# Agent Skills 只读 OSS 挂载：基础设施验证

2026-10-22 14:45–15:12（Asia/Shanghai）在测试服做了一次验证：**当前的沙箱网关和 OSS CSI 已经支持把一个 Agent 的 Skill 目录只读挂进沙箱，不需要升级任何平台组件。** 这次只新增了只读凭证配置，没有改业务代码；Skill 存储仍在 Supabase。

## 新增的配置（`sandbox-system`）

这三个资源已经写进 [storage.yaml](../../deploy/oss-workspace/storage.yaml)，用 `kubectl diff` 核对过，和线上一致。

| 资源 | 作用 |
|---|---|
| CredentialProvider `agentry-skills-ro` | 沿用 RAM 角色 `AgentrySandboxOssRole` 和 `agentry-oss-rw` 的策略模板，但只保留 `oss:GetObject` 和 `oss:ListObjects`。和 Workspace 一样，每个沙箱拿到的 STS 凭证被限定在自己的挂载 subPath 内 |
| AgentRole / AgentRoleBinding `agentry-skills-storage` | 允许沙箱身份 `agentry-workspace` 获取上面这份只读凭证 |

没有改动的：
- 已有的 `agentry-oss-rw`、`agentry-workspace-storage`、PV `agentry-workspace-oss`、RAM 角色及其策略；
- 正式服和测试服的应用配置。

新增的只读凭证对所有使用 `agentry-workspace` 身份的沙箱生效，但只有在创建沙箱时显式请求这个挂载，才会实际签发。

沙箱创建时多带一项挂载配置（PV 与 Workspace 相同）：

```json
{"pvName": "agentry-workspace-oss", "mountPath": "/skills",
 "subPath": "<tenantId>/agents/<agentId>/skills", "readOnly": true,
 "attributes": {"credentialProviderName": "agentry-skills-ro"}}
```

## 方法

- **沙箱模板：** 只用测试专用的 SandboxSet `oma-scale-test-20261021`，从它的预热池领取。网关是 `ack-sandbox-manager v0.6.11`。E2B key 来自 `oma-test/oma-secrets`。
- **测试数据：** 把测试 Agent `agent_tdpcn95CKCCQzEAa5SBGz` 的 19 个 Skill（323 个文件，5,035,957 字节）从 Supabase `workspace-test` 下载下来，上传到隔离的 OSS 前缀 `skillprobe-20261022144523/agents/agent_probe/skills/<skill-name>/`。
- **三个场景：**
  1. 基线：只挂 Workspace，即现有方式；
  2. 目标：Workspace 读写，同时 Skills 只读挂载；
  3. 单独验证凭证层：Skills 挂载设为可写（`readOnly: false`），但仍用只读凭证，挂一个空前缀。

## 结果

| 检查项 | 结果 |
|---|---|
| 同一个 PV 同时挂两个卷 | 通过。网关签发了两份凭证：`agentry-oss-rw` 对应 `…/ws_probe`，`agentry-skills-ro` 对应 `…/agents/agent_probe/skills` |
| 挂载形态 | `/skills` 是 `fuse.ossfs`，挂载参数为 `ro`；Workspace 仍是 `rw` |
| 内容一致性 | 323 个文件的 SHA-256 全部和源文件一致，没有多出或缺少的文件 |
| 挂载层只读 | 新建、追加、删除、mkdir、重命名、chmod、rmtree 全部返回 `EROFS`，Skill 文件完好；同一个沙箱里 Workspace 写入正常 |
| 凭证层只读 | Skills 挂载设为可写时，写入返回 `EPERM`；OSS 里查到 0 个对象 |
| 空前缀（Agent 还没有 Skill） | 挂载成功，`/skills` 为空目录 |
| 领取沙箱耗时（预热池） | 只挂 Workspace：0.52–1.02 s；Workspace 加 Skills：0.34–0.50 s。多一个挂载没有带来可测的额外耗时 |
| 读性能 | 第一次读 SKILL.md 37 ms；读完 19 个 SKILL.md 共 625 ms；遍历 70 个目录 2.3 s；串行读完全部 323 个文件 7.5 s，再读一遍 9.6 s（没有数据缓存） |
| 执行脚本 | 在挂载目录里执行 `python3 <skill script> --help` 用 130–187 ms，复制到本地盘后 40 ms；从挂载目录 import 模块 199–403 ms。只读挂载上不会生成 `__pycache__`，Python 能正常处理 |
| Host 侧修改后多久可见 | 修改已有文件：下次读取立即可见（0 s）。新增文件：立即可见（0 s） |
| Host 侧删除后多久可见 | 删除的文件：`open` 立即返回 `ENOENT`。已经被 stat 过的条目：`exists()` 或列目录还会继续显示，持续约 900 s。删除的整个 Skill 目录：先显示为空目录，897.8 s 后才消失 |

## 结论和注意事项

1. **方案可行：** 每个 Agent 一个目录、只读挂载、只读凭证，现有基础设施全部支持。
2. **只读的真正保证在凭证层。** 沙箱用户能免密 `sudo`（`sudo -n true` 退出码为 0），理论上可以把挂载重新改成可写。但只读凭证会让写入失败，这一点已经单独验证过。
3. **删除和改名有约 15 分钟的列表残留。** 文件内容总是最新的，但已经被看到过的条目会在列表里多留约 900 s；卸下或改名 Skill 后，旧目录会以空目录的形式短暂残留。由于 Skill 清单由 Host 每个 Turn 从 PG 读出并注入提示词，残留的空目录不影响模型拿到的 Skill 列表。如果需要缩短这个窗口，可以给 Skill 单独建一个 PV 并调小 stat 缓存。这个做法**还没有验证**，而且会改变 PV 的共用方式。
4. **按需读取足够快，整树扫描较慢。** 模型通常只读 SKILL.md 和少量参考文件，单个文件约 35 ms。`grep -r` 或遍历整个 Skill 树要秒级，脚本每次启动多约 100 ms。
5. 用 `ossutil cp -r` 上传时会额外生成 71 个目录对象。正式迁移时需要决定保留还是去掉它们，对挂载后的读取没有影响。

## 没有验证的部分

- 200 个沙箱同时创建时，双挂载对 STS 签发和 CSI 的压力；
- 冷启动（新建 Pod，不经过预热池）时的挂载耗时；
- 第二个 ossfs 进程消耗的资源（它在沙箱可见的进程空间之外）；
- 凭证在 1 h 有效期后自动刷新。Workspace 挂载已经验证过刷新（见 [oss-workspace-acceptance](../oss-workspace-acceptance.md)），Skills 挂载用的是同一套机制，但没有单独测。

## 清理

7 个探测沙箱全部已杀掉，`sandbox-system` 里不再有带 `oma.dev/probe` 注解的沙箱；探测用的 OSS 前缀已删除（剩余 0 个对象）；预热池恢复到 5/5。新增的只读凭证配置保留，供后续实现使用。

逐步记录和耗时见 [JSON 证据](skills-oss-mount-2026-10-22.json)。证据里不包含凭证、签名 URL 或 Skill 正文。
