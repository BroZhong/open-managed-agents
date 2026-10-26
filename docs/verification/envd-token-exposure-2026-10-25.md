# envd 访问令牌在 Sandbox 内的可见性（2026-10-25）

[环境快照基准](environment-snapshot-bench-2026-10-25.md)发现：同一 Checkpoint 克隆出的所有 Sandbox 共用构建 Sandbox 的 envd 访问令牌。本次验证回答：Sandbox 内的代码能否拿到令牌，拿到后能否访问另一个 Sandbox 的 envd。

## 方法

- 用 oma-test 的 E2B key 从 `auto-story-v2` 预热池领取 A、B 两个 Sandbox（e2b SDK 2.24.0），metadata `oma.dev/load-test=token-check-20261025`。
- 令牌只在本机内存里比较；Sandbox 内只输出文件和环境变量值的 sha256，在本机与令牌的 sha256 比对。没有输出任何令牌或 key。
- 在 A 内分别以 `user` 和 `root` 扫描 `/var/opt/sandbox/agent-token`、`/var/run/agent-runtime`、`/var/run/agent-helper`、`/mnt/envd` 下的文件，以及所有可读的 `/proc/*/environ`。
- 在 A 内用 curl 访问 B 的 envd（`https://49983-<B>.sandbox.agentry.welltop.tech`，令牌头 `X-Access-Token`），以及集群内 `sandbox-manager.sandbox-system.svc`。
- 结束后 kill A、B，并用 kubectl 确认两个 Sandbox CR 均为 NotFound；本机凭证文件已删除。

## 结果

| 检查 | 结果 |
|---|---|
| A、B 令牌是否相同（非克隆） | 不同，长度均为 36 |
| 运行时挂载目录 | 4 个目录均为 `root:root 777`；只有 `/mnt/envd` 有文件（envd、agent-helper、sandbox-runtime-storage、两个脚本），`user` 可读 |
| 以上文件是否等于令牌 | 否（user 和 root 均扫描） |
| `/proc/*/environ` 中是否有令牌 | 否。`user` 只能读自己的进程；`root` 能读 4 个进程 |
| `root` 能读到的敏感变量名 | `/proc/1/environ` 等含 `OSS_READ_ACCESS_KEY_ID/SECRET`、`VFS_TOKEN`、`OPENGROVE_WW_ACCESS_TOKEN`（pod spec 注入的 base-secret） |
| 命令环境变量名（user） | `E2B_SANDBOX HOME LOGNAME PATH PWD SHLVL USER`，无令牌 |
| A → B envd `/health`（无令牌） | 204 |
| A → B envd `/files`（无令牌） | 401 |
| A → B envd `/files`（A 的令牌） | 401 |
| A → B envd `/files`（B 的令牌） | **200** |
| A → `sandbox-manager:7788` / `:8080` | 500 / 404（网络可达） |

B 的 envd 地址在 A 内解析到公网 ALB（101.133.160.132）。

## 结论

envd 严格按令牌鉴权：别的 Sandbox 的令牌无效，正确的令牌从任何地方都能访问。因此，共用令牌的克隆之间，只要一方拿到令牌就能访问所有兄弟克隆。

普通 `user` 代码拿不到令牌：令牌不在文件里，也不在任何可读的进程环境里。令牌只存在于 envd 进程内存和 Checkpoint CR 的 `init-runtime-request` 注解中（明文，需要集群权限才能读）。以 `root` 运行的代码能否从 envd 进程内存读出令牌，本次没有验证（推断：root 可以 ptrace 同容器进程，风险存在）。Environment 的初始化脚本以 root 在构建 Sandbox 中运行，构建 Sandbox 的令牌正是所有克隆共用的那个，所以恶意脚本可能在构建时取走令牌。

附带发现：

- `root` 能从 `/proc/1/environ` 读到 pod spec 注入的平台密钥，即使 Environment 没有声明它们。以 root 运行的初始化脚本因此能拿到全部 base-secret。
- Sandbox 内可以访问集群内的 sandbox-manager 服务（仍需 API key）。

## 未验证

- root 能否读取 envd 进程内存中的令牌。
- 克隆 Sandbox 的 ID 是否可被枚举（克隆名形如 `<checkpointId>-xxxxx`）。
