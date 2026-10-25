# Base Image：oma-base 与 oma-media，以及 Host 按镜像 digest 领取（#301 第一阶段）

2026-10-26（Asia/Shanghai），#301 第一阶段：两个 Base Image 的配方、构建、推送与离线验收；Host 领取 Sandbox 时总是带镜像 digest；oma-test Warm Pool 清单（未 apply）。oma-test 上的池子、ImageCache 和领取/换镜像实测在第二阶段补到这里或单独的验证文档。逐项数据见 [JSON 证据](base-images-2026-10-26.json)。

**结论：**

1. **两个 Base Image 已构建、验收并推送**（`welltop/oma-sandbox`，新 tag，单个 Docker v2 manifest）：

   | 镜像 | tag | digest | 层数 | 压缩 | 解包 | 构建提交 |
   |---|---|---|---:|---:|---:|---|
   | oma-base | `oma-base-0.1.2` | `sha256:618d3a4f3114b8777998c9d75407f20a531396924c827cd4f3de9595e4418390` | 37 | 952,244,068 B | 4.11 GB | `a28bb52` |
   | oma-media | `oma-media-0.1.2` | `sha256:9a57f901b5df1aa280390b0256aac93c8e724aacb1f9f2831e9ccd441d90ac00` | 42 | 982,716,715 B | 4.21 GB | `ca5fe3e` |

   digest 记在 `sandbox/oma-base/image.lock.json`、`sandbox/oma-media/image.lock.json`；`oma-media/versions.json` 以 digest 引用 oma-base。0.1.0、0.1.1 已推送但作废，原因见“过程与异常”。
2. **主进程收到 SIGTERM 后立即退出。** PID 1 是 `/usr/bin/tini -g -- bash /root/.jupyter/start-up.sh`；Jupyter 就绪后 `docker kill --signal TERM`，oma-base 134 ms、oma-media 120 ms 以 143 退出。对照：线上 0.3.3（PID 1 为 `bash start-up.sh`）15 s 后仍在运行。
3. **镜像配置不加任何环境变量。** 两个镜像的 `Env` 与 ACS 基础镜像逐项相同，没有代理变量、没有密钥；只改了 `Entrypoint`/`Cmd` 和 `Labels`。
4. **离线验收全部通过**（`--network none`，以 `user` 运行，最小 PATH）：Node v22.23.2；Pi 0.83.0（与 Host 一致）七个工具；rg 15.1.0 / fd 10.4.2 的 Pi 语法；Debian 包版本（tini、procps、unzip、libglib2.0-0）；python3/pip3 指向 ACS `/opt/venv`；pip、npm、apt 都指向阿里云源；`/home/user` 只有三个 skeleton 文件、全部归 `user`，没有缓存，`workspace` 不存在；`write-manifest` 输出完整且不写 `/home/user`；oma-media 另有 FFmpeg 9.0.1 链接库完整、10 个编码器与 3 个滤镜、libopenh264 和 libx264 编码、经 libass 烧录中文 SRT/ASS 字幕、Noto CJK 与 DejaVu 字体。
5. **Host 每次创建都从配置的 Warm Pool 领取，并带上镜像 digest。** 镜像来自新的必填配置 `SANDBOX_IMAGE`（必须是 `<仓库>@sha256:<64 位>`）；不是 digest 的镜像在调用网关之前就以 400 拒绝。是否换了镜像由 Host 在 Sandbox 内观测（见“Host”），写进 `span.sandbox_prepare_end`。集群实测留到第二阶段。
6. **oma-test Warm Pool 清单**：`sandbox/warm-pool/oma-test-sandbox.yaml`，就是线上 `auto-story-v2` 模板去掉 18 个 base-secret pod env。命令拿到的变量不变：Host 在创建时注入 base-secret 的全部 25 个键，pod env 本来就只有 PID 1 看得到。

## 配方

| 目录 | 内容 |
|---|---|
| `sandbox/oma-base/` | `Dockerfile`、`versions.json`（ACS 基础镜像、node-base、Pi、Debian 包版本、源）、`pi-tools/`（与 Host 相同的锁文件）、`pip.conf`、`npmrc`、`write-manifest`、`smoke.py`、`verify-image.sh`、`build.sh`、`image.lock.json` |
| `sandbox/oma-media/` | `Dockerfile`（FFmpeg 构建阶段 + 运行阶段）、`versions.json`（oma-base digest、FFmpeg 源码 SHA-256 与签名）、`fetch-sources.py`、`smoke.py`、`build.sh`、`image.lock.json` |

- **oma-base**：ACS `code-interpreter@sha256:b53bc461…`；apt 改阿里云并去掉 nodesource 源；`tini`、`procps`、`unzip`、`libglib2.0-0` 固定版本；`/usr/local/bin/node` 来自 Host 的 node-base（22.23.2）；`/opt/oma-pi-tools` 用锁文件 `npm ci`（缓存放 `/tmp` 后删除）；rg/fd 用固定的发布包和二进制哈希；`/usr/local/bin/python3|python|pip3|pip` 包装到 `/opt/venv`；`/opt/oma/bin/write-manifest`；`/opt/oma/images/oma-base.json` 记版本。没有 `ENV`。
- **oma-media**：`FROM oma-base@sha256:618d3a4f…`；FFmpeg 9.0.1 源码（`cf38e0e2…`，与 auto-story-v2 相同的 configure 选项）在构建阶段编译，运行阶段只装运行库、`fontconfig`、`fonts-dejavu-core`、`fonts-noto-cjk`。vfs-cli、mediakit-cli、ossutil、google-genai 等不进 Base Image，由 `video-production` 的 init 脚本安装。
- **构建**：`build.sh` 先核对 Pi 版本（Host 的 `adapter/packages/pi-agent/package.json` = 锁文件 = `versions.json`），构建后跑 `verify-image.sh`，通过才推送；推送前检查 tag 不存在，从不覆盖。`build.sh` 只构建与推送，不改任何 SandboxSet。
- **构建耗时（vfs-dev，ACS 基础镜像已在本地）**：oma-base 构建加验收约 2 min（`npm ci` 6.9 s）；oma-media 约 6 min，其中构建依赖的 apt 安装 158 s、FFmpeg 编译 153 s（10 并发）。

## 验收

`verify-image.sh` 对每个镜像：

| 检查 | oma-base-0.1.2 | oma-media-0.1.2 |
|---|---|---|
| `Entrypoint` / `Cmd` | `["/usr/bin/tini","-g","--"]` / `["bash","/root/.jupyter/start-up.sh"]` | 继承 |
| `Env` 与 ACS 基础镜像相同、无 `*_proxy` | 是 | 是 |
| oma-base smoke（7 项） | 通过 | 通过 |
| oma-media smoke（6 项） | — | 通过 |
| Jupyter `/api/status` | 就绪 | 就绪 |
| SIGTERM → 退出 | 143，134 ms | 143，120 ms |

- **oma-base smoke**：`versions`（node、Pi、rg、fd、tini 与 4 个 Debian 包版本）；`pi_native_tools`（read、write、edit、ls、find、grep、bash）；`native_search`；`python_and_mirrors`（`python3` → `/opt/venv`，pip 源，npm 源在 Host 注入的 `NPM_CONFIG_PREFIX` 下仍生效，apt 源全部为 `mirrors.aliyun.com`）；`utilities`（ps、unzip）；`home_layout`；`write_manifest`。
- **oma-media smoke**：`ffmpeg_build`（版本、`ldd` 无缺失、9 个运行包已安装、编码器与滤镜）；`encode_libopenh264`、`encode_libx264`（H.264/AAC，320×240，2 s）；`subtitles_libass_cjk`（黑底上烧录“中文字幕测试”与“样式字幕”，亮像素 169 与 423）；`fonts`（`Noto Sans CJK SC` → `NotoSansCJK-Regular.ttc`，15 个覆盖 zh 的字体族）；`home_untouched`。

### write-manifest

镜像内以 root 运行 `/opt/oma/bin/write-manifest`（`--network none`）：

| 镜像 | 用时 | 大小 | dpkg | pip | npm | 二进制 |
|---|---:|---:|---:|---|---|---|
| oma-base-0.1.2 | 1.8 s | 32.7 KB | 275 | `/opt/venv` 173，`/usr` 3 | `/opt/oma-pi-tools` 锁定 140 个（Pi 0.83.0）；`/usr/lib/node_modules` 3 个 | node、npm、python3、pip3、tini、rg、fd、git、curl、jq |
| oma-media-0.1.2 | 1.9 s | 34.4 KB | 289 | 同上 | 同上 | 另有 ffmpeg、ffprobe 9.0.1 |

输出还包括 `/usr/local/bin` 每个文件的 sha256、`/opt/oma/images/*.json`。它用临时 HOME 运行 npm/pip，`/home/user` 前后不变；Python 包用每个解释器自己的 `importlib.metadata` 列出，并自动发现 `/opt` 下三层以内和 `/home/user/.local/venvs` 下的 venv。

## base-secret 与 source.env

- 线上 `auto-story-v2`（generation 20）的 pod env 有 18 个 `secretKeyRef`，其中 `GEMINI_API_KEY`、`GEMINI_AUDIO_MODEL` 是 optional 且 base-secret 里没有，实际给 PID 1 的是 16 个。
- base-secret 有 25 个环境变量形式的键（含 `HTTP(S)_PROXY`/`NO_PROXY` 大小写两套、`IS_TEST`、`VFS_OSS_AK/SK`），没有文件键（`source.env` 已不存在）。Host 的 `sandboxBaseEnvFromKubernetes` 读取全部合法键，作为 `defaultSandboxEnv` 在创建时注入；只读核对两个已领取 Sandbox 的 `agents.kruise.io/init-runtime-request`（只看键名）：36 个创建变量，25 个 base-secret 键全在，另 11 个是 `WORKSPACE_ENV`。
- envd 命令只看得到创建变量、本条命令的变量和 `/etc/profile(.d)`；pod env 只有 PID 1（Jupyter）可见。所以去掉 pod env 不改变命令拿到的变量，16 个键原样由 Host 注入。
- 线上模板已经没有 `source.env` 卷；在线上镜像的 `/etc /opt /root /usr/local/bin /home` 里搜 `auto-story-source` 没有结果，没有组件读它。`/etc/profile.d` 为空。
- oma-test 的 Runner 配置（`SANDBOX_BASE_SECRET_NAMESPACE/NAME`）来自共同的 base，test overlay 不改，RBAC `oma-test-read-base-secret` 已存在。

## Warm Pool 清单

`sandbox/warm-pool/oma-test-sandbox.yaml`：`sandbox-system/oma-test-sandbox`，1 副本，SandboxSet 和 Pod 模板都带 `oma.dev/test-only: "true"`。与线上模板（客户端 dry-run 后逐字段比较）的差别只有：

- 去掉 `sandbox` 容器的 18 个 `env`；
- 加 `oma.dev/test-only` 标签；
- 不写服务器端默认字段（`dnsPolicy`、`restartPolicy`、`schedulerName`、`securityContext`、`terminationMessage*`）。

保留：`persistentContents`、`runtimes`（csi、agent-runtime）、`enable-image-cache` 注解、ACS 标签、资源（2C4G，50 Gi 临时盘）、`imagePullSecrets: ali-shanghai`、`terminationGracePeriodSeconds: 30`。第一阶段还保留了 `vfs-cli-policy-test-v1` 的只读挂载、镜像暂用线上 0.3.3。第二阶段换成过渡镜像（oma-media + video-production 的 init.sh，自带同样的策略文件），去掉了这个挂载，`SANDBOX_IMAGE` 同时改，并先建了 ImageCache。

## Host

- **配置**：`SANDBOX_TEMPLATE` 是 Warm Pool 名，必填（不再默认 `auto-story-v2`）；新增必填 `SANDBOX_IMAGE`，不是 digest 时 Runner 启动失败。生产 base（`deploy/app/api-runner.yaml`、`deploy/k8s.yaml`）：`auto-story-v2` + 线上镜像 `…@sha256:67a46af6…`，与池子镜像相同，仍是普通领取。test overlay：`oma-test-sandbox` + 清单里的镜像。部署合约测试要求 test 的 `SANDBOX_IMAGE` 与池子清单的镜像逐字相同。**未 apply。**
- **领取**：`E2BSandboxClient.create` 总是以 `pool` 为模板，并把 `opts.image` 写入 `e2b.agents.kruise.io/image`；`resolveTemplate` 已删除。镜像从 `TurnSandboxes` 的 `sandboxImage`（配置）进入 `EnvSpec.image`，#306 改为来自 Session 的 Environment。Agent 的 `sandbox.image` 不再选择任何东西（oma_test 里有 9 个 Agent 指向已缩到 0 的 `oma-scale-test-*` 池，1 个写 `auto-story-v2`）；`sandbox.env` 与环境变量分层不变（#311）。
- **是否换了镜像**：网关不给信号。上游 `ack-sandbox-manager` 会把 image 键从 metadata 中删掉，`getInfo` 的 metadata 只有 Sandbox CR 的注解和标签，原地更新的状态只写在 Pod 注解和 CR 的 condition 上（`InplaceUpdate` 条件在普通领取后也是 `Succeeded`）。所以 Host 在创建返回后、在 Sandbox 里执行一条只读探测 `cat /proc/uptime /proc/1/stat && getconf CLK_TCK`，与本次创建开始后经过的时间比较：
  - PID 1 比本次领取早启动：保留了预热容器，`swapped: false`；
  - PID 1 在领取之后启动，但内核在领取之前已启动：同一个 Pod 里容器被换掉，`swapped: true`；
  - 两者都在领取之后：Pod 是为这次领取新建的（池子无库存时冷启动），`swapped: false`。
  - 探测失败或输出无法解析：不写 `swapped`，创建照常成功，不记为执行结果不确定。
  - **第二阶段更正：** 实测 ACS 给每个容器单独的 `/proc/uptime`（PID 1 从 0 开始），这一版把每次换镜像都记成了 `false`。现在改为用 `/etc/hostname` 的 ctime 判断 Pod 年龄（提交 `6c79c1e`），见 [warm-pool-oma-test-2026-10-26.md](warm-pool-oma-test-2026-10-26.md)。
- **span**：建出 Sandbox 的那次准备，其 `span.sandbox_prepare_end` 多出 `image`、`swapped`、`claimMs`（网关 create 的耗时）；连接已有 Sandbox 的准备不带这些字段。

## 过程与异常

1. **0.1.0 作废**（`oma-base-0.1.0` `sha256:007d0b4c…`，`oma-media-0.1.0` `sha256:5a33456b…`）：#305 的脚本依赖 Base Image 提供 `libglib2.0-0`（OpenCV 需要），0.1.0 没有显式安装（oma-media 里只是 harfbuzz 的间接依赖）。
2. **0.1.1 作废**（`oma-base-0.1.1` `sha256:7cb1e7a4…`）：npm 源写在 `/usr/local/etc/npmrc`。Host 创建时注入 `NPM_CONFIG_PREFIX=/home/user/.local/npm`，npm 的全局配置随之移到 `/home/user/.local/npm/etc/npmrc`，按命令环境运行时 registry 回落到 `registry.npmjs.org`。改为 npm 自带的 builtin 配置 `/usr/lib/node_modules/npm/npmrc`，smoke 改为在该前缀下检查。ACR 个人版不能删 tag，旧 tag 保留，不被引用。
3. 第一次构建的 smoke 把 deb822 源文件里的注释当成了源地址；`build.sh` 按 `.` 拆键读不到 `libglib2.0-0`。都已修正。
4. vfs-dev 不能直连 GitHub 和 ffmpeg.org：rg/fd 二进制和 FFmpeg 源码复用本机已有的副本（`RG_SRC`/`FD_SRC`/`FFMPEG_SRC`），由配方里的 SHA-256 校验。
5. 本阶段没有集群写操作。只读：`auto-story-v2` SandboxSet、base-secret 的键名、两个已领取 Sandbox 的创建变量键名、oma_test 的 Agent `sandbox.image` 统计。

## 测试

- `server/packages/sandbox`：279 通过（10 跳过）；`session-router`：453 通过；`api`：1816 通过（20 跳过）；真实 PG（`turn-sandboxes`、`binding-reconciliation`、`sandbox-sweeper`）：101 通过（5 跳过）。
- `node --test deploy/*.test.mjs`：35 通过（1 跳过），含 #305 的内置 Environment 检查。
- `pnpm --dir server typecheck`、各包 `tsc --noEmit`（含测试）、`pnpm --dir adapter typecheck` 通过。

## 复现

```bash
git bundle create /tmp/oma-env-301.bundle wt/301-warm-pool-base-images   # 本机
# vfs-dev：
git clone /tmp/oma-env-301.bundle ~/workspace/yuzhong/oma-env-301-<sha> -b wt/301-warm-pool-base-images
RG_SRC=… FD_SRC=… PUSH=1 bash sandbox/oma-base/build.sh
FFMPEG_SRC=… PUSH=1 bash sandbox/oma-media/build.sh
```
