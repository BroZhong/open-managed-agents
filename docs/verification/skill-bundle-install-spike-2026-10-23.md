# Skill 版本包安装：200 个 Sandbox 同时首次安装（#261）

2026-10-23 01:38–02:08（Asia/Shanghai）在测试服验证了 #259 定下的安装路径。Host 用 OSS 内网 endpoint 为每个 Skill 包签发短期 GET URL，经标准输入交给 Sandbox。Sandbox 以 root 身份绕过代理下载、校验 sha256、解压到 `/opt/oma/skills/<setHash>`、设置只读权限，再原子切换 `/skills`。**结论：这条路径在 200 个 Sandbox 同时首次安装时全部成功，不需要退回由 Host 推送内容。** 本次没有改动业务代码、正式服或任何集群资源；只创建并销毁了自己的测试 Sandbox，用过的 OSS 前缀也已删除。

## 给 #265 实现者的要点

1. **以 root 执行可行。** `sandbox.commands.run(cmd, { user: "root" })` 得到 uid 0，HOME 为 `/root`。不需要 sudo 退路；作为对照，默认用户执行 `sudo -n id -u` 同样返回 0。
2. **标准输入不能用 EOF。** 网关报告的 envd 版本是 0.2.10，SDK（e2b 2.24.0）要求 envd ≥ 0.5.2 才允许 `closeStdin`，否则直接抛 `SandboxError`。可用的做法：先 `commands.run(cmd, { user: "root", background: true, stdin: true, timeoutMs })` 取得 `pid`，再 `commands.sendStdin(pid, payload)`。协议按行、带记录数，脚本用 `read -r -t 30` 读满固定行数，不依赖 EOF。见 [install.sh](../../deploy/scripts/skill-bundle-spike/install.sh) 文件头：

   ```text
   OMA1 <setHash> <bundleCount> <limitRate|0>
   <sha256> <sizeBytes> <base64(skillName)> <signedUrl>     × bundleCount
   ```

   Skill 名称只排除 `/`，可能含空格或中文，所以名称以 base64 传输。测试里的 fixture 名为 `oma-spike fixture-测试`，可以正常安装。
3. **URL 只经过 curl 的标准输入。** bash 内置 `printf` 把 `url = "…"` / `output = "…"` 写进管道，交给 `curl --noproxy '*' --config - --parallel --parallel-max 8`。URL 不进入 argv、环境变量、文件或输出。脚本只输出一行由数字和固定阶段名组成的 JSON。
4. **解压用镜像自带的 Info-ZIP `unzip`。** 它会按 zip 外部属性恢复 Unix 权限位，UTF-8 文件名也完整。之后统一改权限：`chown -R 0:0`；目录和带 x 位的文件改为 0555，其余文件改为 0444；最后 `mv -T` 临时目录到版本目录，再用 `ln -sfn` 加 `mv -Tf` 切换 `/skills`。Python `zipfile.extractall` 会丢失权限位，所有文件都变成 0644，不能直接作为退路。
5. **内网 endpoint：** 签名用 `https://oss-cn-shanghai-internal.aliyuncs.com`，生成的 URL 主机是 `agentry.oss-cn-shanghai-internal.aliyuncs.com`，在 Sandbox 内解析为 100.118.102.33–36。正式 Sandbox 从 base Secret 继承 `HTTP(S)_PROXY`，指向 oma-infra 的 sing-box；对应的 `NO_PROXY` 不包含 `aliyuncs.com`，所以 `--noproxy '*'` 是必需的。
6. **耗时：** 200 路并发时，Host 观测的安装耗时 p50 1.79 s，p95 1.90 s，max 2.28 s。OSS 错误为 0，4,000 次下载全部一次成功。真实 Skill 集合远小于 30 s 的预算下限。吞吐系数建议**维持 20 MB/s**：64 MiB 级包的端到端安装吞吐最低实测 29.4 MB/s。
7. **工具清单来自测试模板。** 测试模板的镜像是 `d0a84574…`，正式模板 `auto-story-v2` 当前的镜像是 `67a46af6…`，两者不同。上线前需要在正式镜像上复核 curl、unzip、flock 是否存在。
8. **已有 Sandbox 的迁移要单独处理。** 新建 Sandbox 里没有 `/skills` 和 `/opt/oma`。但由旧逻辑同步过 Skills 的 Sandbox，`/skills` 是一个普通目录，`mv -Tf` 不能用软链接覆盖目录。spike 脚本遇到这种情况会报 `legacy-skills-dir` 并失败。#265 需要在安装锁内处理这个旧目录。

## 方法

- **环境：** 只使用测试专用 SandboxSet `oma-scale-test-20261021`（预热 5 个，每个 2 CPU / 4 GiB，镜像 `sha256:d0a84574…`）。网关是 `ack-sandbox-gateway v0.3.0` 和 `ack-sandbox-manager v0.6.11`。E2B 和 OSS 配置从 `oma-test/oma-runner` 的进程环境读取，只读进脚本进程。Host 凭证就是 Runner 使用的 Workspace OSS key。驱动脚本运行在本机，经公网 ALB 访问网关。
- **测试数据：** 测试 Agent `agent_tdpcn95CKCCQzEAa5SBGz` 装备的 19 个 Skill，共 323 个文件、5,035,957 字节。数据通过 oma-test Pod 读取：PG 一个 READ ONLY 事务，加上 Supabase `workspace-test` 的 list/get；没有任何写入。Supabase 不记录文件权限，所以以 `#!` 开头的 43 个文件被标为可执行。
- **打包：** 用 Python `zipfile` 每个 Skill 打一个包：deflate 压缩，写入 Unix 外部属性和显式目录项，时间戳固定，使用 UTF-8 文件名。19 个包共 1,948,235 字节。另有两个包：
  - fixture（8 个文件，475,072 字节）：官方 liberation-fonts 2.1.5 的 `LiberationSans-Regular.ttf`（410,712 字节，sha256 `76d04c18…`，已校验 `head` 表魔数）、0755 的 `bin/run.sh`、带 shebang 但为 0644 的脚本、256 KiB 随机数据、空文件、带空格的中文文件名、0600 的六层嵌套文件；
  - 校准包：64 MiB 随机数据，不可压缩。
- **对象：** 上传到隔离前缀 `__oma/skills-spike-<时间戳>/<tenantId>/<sha256>.zip`，共 21 个对象、69,552,760 字节。
- **集合：** A 为 19 个 Skill 加 fixture（20 个包，2,423,307 字节）；B 为 A 去掉一个 Skill，用于切换和 argv 探测；C 为 A 加校准包（21 个包，69,552,760 字节）。集合哈希是排序后的 `name\0sha256\n` 列表的 sha256。
- **代理模拟：** 创建 Sandbox 时设置与正式 base Secret 同名的 `HTTPS_PROXY`、`HTTP_PROXY`、`https_proxy`、`http_proxy`、`NO_PROXY`、`no_proxy`。代理值指向不可达的 `127.0.0.1:9`，`NO_PROXY` 与正式值相同。这样如果没有绕过代理，请求会直接失败，不会进入正式服的代理。
- **逐级加量：** 先做 1 个 Sandbox 的完整检查（工具清单、unzip 行为、首次安装、重复安装、切换、argv 采样、大包校准、日志扫描），再做 10 个，最后做 200 个。每一级先并发领取全部 Sandbox，再同时触发首次安装，安装完成后再逐个核对文件树。领取耗时和安装耗时分开统计。
- **核对文件树：** 在 Sandbox 内以默认用户（uid 1000）遍历 `/skills`，计算每个文件的 sha256 并读取权限和属主，由 Host 与源文件逐项比对。同时尝试写入，确认被拒绝。

## 结果

### 执行机制、镜像和网络

| 检查项 | 结果 |
|---|---|
| root 执行 | `user: "root"` 返回 `root uid=0 home=/root`。默认用户是 `user uid=1000`；`sudo -n` 也可用 |
| 标准输入 | root 进程用 `read -r` 读到了 `sendStdin` 发送的整行。`closeStdin` 被 SDK 拒绝（envd 0.2.10 < 0.5.2） |
| 系统 | Debian 12 x86_64，2 vCPU，根目录为 49 GB overlay |
| 可用工具 | bash 5.2.15、curl 7.88.1（OpenSSL 3.0.18、nghttp2）、UnZip 6.00（Debian）和 zipinfo、Python 3.11.2（`/usr/local/bin/python3`）、sha256sum / mv / ln（coreutils 9.1）、flock（util-linux 2.38.1）、jq、base64、find、stat、mktemp、timeout、sudo |
| 缺少的工具 | `zip`、`bsdtar`、`wget` |
| 语言环境 | 有 `C.utf8` |
| 初始状态 | `/skills` 和 `/opt/oma` 都不存在 |
| 代理环境 | 默认用户和 root 的 login shell 都继承了 6 个代理变量 |
| 不绕过代理访问内网 endpoint | `http=000 curl_exit=7`，被不可达的代理挡住 |
| `--noproxy '*'` | `http=403 ip=100.118.102.33`：直连成功，匿名访问 Bucket 根路径被拒，符合预期 |

### unzip 行为（fixture 包）

| 解压方式 | UTF-8 文件名 | 权限位 |
|---|---|---|
| Info-ZIP unzip，`LC_ALL=C` | 完整 | 755 / 644 / 600 全部保留 |
| Info-ZIP unzip，`LC_ALL=C.UTF-8` | 完整 | 全部保留 |
| Python `zipfile.extractall` | 完整 | **丢失**，全部为 644。zip 内的外部属性本身是完整的，若用作退路，需要逐个 `chmod` |

### 字节与权限

1、10、200 三级的每个 Sandbox 都通过了文件树核对。集合 A 共 331 个文件（323 个 Skill 文件加 8 个 fixture 文件）和 82 个目录：sha256、大小、权限、属主全部一致，没有缺失或多余的条目。

- **二进制完整：** 有效 TTF 和 256 KiB 随机数据安装后与源文件逐字节一致。
- **存储中的字体本身已损坏：** Supabase 中 `precise-subtitles` 的 `assets/fonts/LiberationSans-Regular.ttf` 是 544,485 字节，其中有 67,061 个 U+FFFD 序列，原始文件应为 410,712 字节。安装结果与这份损坏的源文件逐字节一致。损坏发生在上游存储，打包和安装不会修复它；迁移到版本包时需要重新上传正确的字体。
- **权限：** 44 个可执行文件（43 个 shebang 文件加 `bin/run.sh`）为 0555；其余文件为 0444，包括源权限为 0600 的文件和带 shebang 但没有 x 位的脚本；所有目录和版本目录本身为 0555；属主全部是 0:0。
- **执行：** `bin/run.sh` 输出 `fixture-ok`，退出码 0；`bin/not-executable.sh` 退出码 126。
- **写入被拒：** uid 1000 的创建、覆盖、删除、mkdir、重命名、替换 `/skills` 软链接、删除 `/skills` 都返回 `EACCES`，chmod 返回 `EPERM`。
- **重复安装：** 同一集合再次安装时直接复用版本目录，Host 观测 117 ms。
- **切换：** 换装集合 B 后，`/skills` 指向 B 的版本目录（264 个文件，核对通过）；A 的版本目录原样保留（331 个文件，核对通过）。

### URL 泄漏检查

| 检查项 | 结果 |
|---|---|
| 进程参数和环境变量 | 安装 B 时把每个传输限速到 100 kB/s，让 curl 持续约 1.8 s，同时以 root 采样所有进程的 `/proc/*/cmdline` 和 `/proc/*/environ`：815 次采样，其中 541 次 curl 正在运行，签名 URL 特征（`x-oss-`、`aliyuncs`、`OSS4-HMAC`）命中 0 次 |
| 文件 | `/tmp`、`/var/tmp`、`/root`、`/home/user`、`/opt/oma`、`/var/log`、`/etc` 下没有包含 `x-oss-signature` 或 `x-oss-credential` 的文件 |
| 脚本输出 | 全部安装的 stdout/stderr 都不含上述特征，也不含任何凭证（`outputLeaks=0`） |
| 日志 | 1 号 Sandbox 的 4 个容器日志，以及 gateway 和 manager 最近 30 分钟的日志，命中 0 次 |

### 并发首次安装（集合 A，2,423,307 字节，20 个包）

| | 1 个 | 10 个 | 200 个 |
|---|---:|---:|---:|
| 领取成功 | 1/1 | 10/10 | 200/200 |
| 领取耗时，Host 观测（p50 / p95 / max） | 0.25 s（预热） | 23.3 / 28.4 / 28.4 s | 39.1 / 65.3 / 132.8 s |
| 冷启动 create→Ready，服务端（p50 / p95 / max） | — | 27 / 28 / 28 s（冷启动 6 个，预热 4 个） | 27 / 39 / 133 s（冷启动 195 个，预热 5 个） |
| 安装成功 | 1/1 | 10/10 | 200/200 |
| 安装耗时，Host 观测（p50 / p95 / max） | 0.70 s | 0.88 / 1.64 / 1.64 s | **1.79 / 1.90 / 2.28 s** |
| 安装耗时，Sandbox 内（p50 / p95 / max） | 0.67 s | 0.76 / 1.34 / 1.34 s | 1.39 / 1.51 / 1.89 s |
| 其中等待标准输入（p50 / max） | 75 ms | 112 / 349 ms | 765 / 944 ms |
| 下载阶段（p50 / p95 / max） | 314 ms | 334 / 586 / 586 ms | 315 / 353 / 505 ms |
| 校验 / 解压 / 权限 / 切换（p50） | 65 / 170 / 20 / 6 ms | 75 / 197 / 23 / 7 ms | 69 / 181 / 21 / 7 ms |
| 单 Sandbox 下载吞吐（p50，最低） | 7.7 MB/s | 5.7 MB/s，4.1 MB/s | 7.7 MB/s，4.8 MB/s |
| 全部安装的总耗时 / 聚合吞吐 | — | 1.7 s / 14.6 MB/s | 2.4 s / 202 MB/s |
| OSS 错误 / 下载次数 | 0 / 20 | 0 / 200 | **0 / 4,000** |
| 每个 Sandbox 的 TCP 连接数 | 8 | 8 | 8 |
| 文件树核对通过 | 1/1 | 10/10 | 200/200 |

- **安装耗时的计量范围：** Host 观测从调用 `commands.run` 开始，到进程结束返回为止，包含启动进程、投递标准输入和安装本身，不含签名。签名 20 个 URL 的耗时：单个 Sandbox 时 2 ms；200 路同时签名时 p50 116 ms，耗在 Host 的事件循环上。
- **小包的耗时由固定开销决定：** 20 个小对象通过 8 个复用连接下载，耗时主要是请求往返，不是带宽。按字节算的端到端吞吐只有 1.1–3.5 MB/s，但这对小集合没有意义。
- **标准输入延迟：** 200 路时，进程启动后要等 0.4–0.9 s 才收到标准输入。这一段走的是本机经公网 ALB 到网关的链路：每个 Sandbox 都要发起一次新的 `sendStdin` 请求。Runner 在集群内走 `E2B_SANDBOX_URL`，链路不同，没有实测。

### 大包校准（集合 C，69,552,760 字节）

| | 1 个 | 10 个同时 |
|---|---:|---:|
| 下载吞吐（单 Sandbox） | 98.5 MB/s | 最低 73.4，p50 90.4，最高 109.5 MB/s |
| 端到端安装吞吐（Host 观测，含下载、sha256、解压、权限、切换） | 40.2 MB/s（1.73 s） | **最低 29.4**，p50 38.2，最高 41.5 MB/s |
| 阶段耗时（1 个） | 下载 706 ms，sha256 343 ms，解压 518 ms，权限 19 ms，切换 5 ms | — |
| 聚合吞吐 | — | 293 MB/s |
| OSS 错误 / 文件树核对 | 0 / 通过 | 0 / 10 通过 |

**预算系数建议维持 20 MB/s。**

- **余量：** 大包端到端吞吐的最低实测是 29.4 MB/s，20 MB/s 比它低约 1.5 倍；单看下载，最低 73 MB/s，余量更大。
- **计量口径：** 字节数用 zip 字节，即清单中包大小之和，下载和校验的耗时与它成正比。对于不可压缩数据，解压耗时与 zip 字节相当。
- **30 s 下限：** 按 20 MB/s，600 MB 以内的集合预算都是 30 s。真实集合在 200 路并发时最长 2.28 s，比预算快 13 倍。
- **账号带宽：** 本次观测到的聚合峰值约 293 MB/s（≈ 2.3 Gbit/s）。OSS 文档写明，上海地域单个账号内外网总下载带宽上限为 100 Gbit/s（[OSS 使用限制](https://help.aliyun.com/zh/oss/product-overview/limits)），这次压测离上限很远。这份额度与正式服 Workspace 等业务共用。

## 注意事项与意外发现

1. **旧的 `/skills` 目录。** 新建 Sandbox 没有这个目录，但旧逻辑同步过 Skills 的 Sandbox 里有。原子切换要求 `/skills` 是软链接或不存在，所以 #265 必须在安装锁内迁移已有目录：例如确认没有进行中的旧式同步后删除它，或者改名移走。
2. **领取耗时有长尾。** 200 路时有两个 Sandbox 分别用了 123 s 和 133 s，已接近创建配置里 150 s 的 claim / wait-ready 超时。这与安装无关，但同时首次运行的批量任务应把领取和安装分开计时。
3. **旧版本目录会累积。** 切换后旧版本目录仍然保留，这样正在读取旧版本的进程不受影响。#265 需要定义回收策略，不能删除当前软链接指向的版本，也不能删除可能仍在使用的版本。
4. **只读是约定，不是安全边界。** 写入被拒依赖 root 属主和 0555/0444 权限。Agent 用户可以免密 `sudo`，结论与 [skills-oss-mount](skills-oss-mount-2026-10-22.md) 相同。
5. **本机工具链的两个问题，与平台无关。**
   - 第一次 200 路尝试中，200 个 Sandbox 全部领取成功，但安装请求在本机就失败了：`fetch failed`，0 次下载，网关日志也没有错误。原因是本机解析器对不同主机名的查询串行处理，200 个 `<port>-<sandboxId>.<domain>` 用了约 22 s，超过了连接超时；把 `UV_THREADPOOL_SIZE` 调到 128 也无效。修复方法：这些主机都是网关 ALB 的 CNAME（脚本会先断言这一点），驱动脚本对 `*.<E2B_DOMAIN>` 只做一次解析并缓存，TLS SNI 和 Host 不变。Runner 在集群内只使用一个服务地址，不受影响。
   - 另一次尝试中，`kubectl exec` 截断了 6.7 MB 的导出输出，在 5,177,344 字节处中断。导出脚本因此加了长度和 sha256 校验行，退出前稍作停留，并允许最多重试 3 次。
   - 两次尝试的经过都记录在 JSON 的 `priorAttempts` 中。

## 没有验证的部分

- **集群内 Runner 的执行链路**（`E2B_SANDBOX_URL` 直连 sandbox-manager）。标准输入延迟和 Host 观测耗时可能与本机经 ALB 的结果不同。
- **200 个 Sandbox 同时安装大包。** 为避免占用共享 Bucket 的带宽，大包只测到 10 路并发。
- **正式模板 `auto-story-v2` 和真实代理。** 正式模板当前的镜像 digest 是 `sha256:67a46af6…`，与本次测试模板的 `d0a84574…` 不同。上面的工具清单（curl、unzip、flock、`C.utf8` 等）需要在正式镜像上复核，或者在安装前做一次工具检查。代理变量名与正式服相同，但本次用的代理值是不可达地址，没有实测 sing-box。
- **失败路径：** 同一 Sandbox 内多个安装进程争用 flock；下载中途 URL 过期；OSS 返回 5xx 时的重试（本次没有出错，重试分支没有走到）；Runner 使用 STS 或最小权限凭证签名（本次用的是 Host 的 Workspace key）。

## 复现

```bash
server/packages/api/node_modules/.bin/tsx deploy/scripts/verify-skill-bundle-install.mts \
  <evidence.json> --font <LiberationSans-Regular.ttf> --waves 1,10,200
```

- **驱动脚本：** [verify-skill-bundle-install.mts](../../deploy/scripts/verify-skill-bundle-install.mts)。
- **Sandbox 侧安装脚本：** [install.sh](../../deploy/scripts/skill-bundle-spike/install.sh)，可供 #265 参考。
- **辅助脚本：** [inspect.py](../../deploy/scripts/skill-bundle-spike/inspect.py)、[pack.py](../../deploy/scripts/skill-bundle-spike/pack.py)、[export-skills.cjs](../../deploy/scripts/skill-bundle-spike/export-skills.cjs)。

脚本会：

- 检查 SandboxSet 带有 `oma.dev/test-only=true`，并确认读到的是 oma-test 配置（schema `oma_test`、Bucket `agentry`）；
- 只创建带 `oma.dev/probe=<runId>` 注解的 Sandbox，超时 30 分钟后自毁；
- 每次运行使用独立的 OSS 前缀；
- 在 `finally` 和 SIGINT 时清理 Sandbox、OSS 对象和本地暂存，并在写出证据前断言其中不含凭证或签名 URL 特征。

## 清理

本次共做了 6 次运行：1 次探索、2 次试运行（1 个 Sandbox；1+10 个）、2 次中断的尝试、1 次正式运行。共创建 435 个测试 Sandbox，全部已销毁。

- `sandbox-system` 中带 `oma.dev/probe` 注解的 Sandbox 剩余 0 个，预热池恢复到 5/5。
- 4 个用过的 OSS 前缀共 84 个对象全部删除，`__oma/skills-spike-` 前缀下剩余 0 个对象。
- 本机暂存的 zip 和导出数据已删除。

逐步数据见 [JSON 证据](skill-bundle-install-spike-2026-10-23.json)，其中包含每个 Sandbox 一行的明细。证据中没有凭证、签名 URL 或 Skill 正文，提交前已用 oma-test 的实际密钥值逐一扫描确认。
