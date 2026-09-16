# auto-story-v2

唯一维护的 Sandbox 镜像。直接从锁定的 ACS `code-interpreter` 基础镜像构建，包含 VFS CLI、FFmpeg、MediaKit、Gemini SDK和 rg/fd；不再叠加旧工具镜像或 workspace overlay。

## Review 顺序

1. `versions.json`：上游版本、下载地址、归档及二进制 SHA-256；vfs-cli 为 **v0.3.16**。
2. `Dockerfile`：共享基础层 → FFmpeg / Python 独立构建阶段 → runtime 组装。
3. `install-python.sh`：独立虚拟环境和 Python/pip 包装器，保留 ACS 科学计算包。
4. `smoke.py` / `verify-image.sh`：离线工具验收和原始 Jupyter 启动检查。

`fetch-sources.py` 先校验上游归档及解压文件，再生成镜像内复验用的 `bin/SHA256SUMS`。搜索工具锁在 `../prepare-search-binaries.py`。Python 直接依赖版本在 `requirements.txt`，验收预期在 `smoke.py`；升级时一起更新。

## 缓存

| 变更 | 需要重建 | 保留缓存 |
| --- | --- | --- |
| vfs-cli | VFS COPY、清单和验收 | FFmpeg、Python、运行库、其他 CLI |
| MediaKit | MediaKit 及后续组装 | FFmpeg、Python、运行库、rg/fd |
| Python requirements | Python 阶段及后续组装 | FFmpeg 编译、运行库 |
| FFmpeg 源码 | FFmpeg 编译及后续组装 | Python 安装、运行库 |
| 镜像版本标签 | 最终 LABEL | 所有安装和验收层 |


FFmpeg 编译只依赖基础镜像、系统编译依赖和源码。Python 安装只依赖基础镜像、requirements 和安装脚本。CLI 按 rg/fd → MediaKit → VFS 的预期升级频率分别 COPY，完整版本锁在最终组装时才复制；改 vfs-cli 不会使前两者的层缓存失效。APT 与 pip 下载使用 BuildKit cache mount，同一 builder 上重复构建可复用。发布版本标签放在最后，改标签也不会重跑验收。

## 构建

在可访问上海 ACS 内网仓库的 Linux amd64 builder 上：

```sh
bash deploy/sandbox/auto-story-v2/build.sh --prepare-only
bash deploy/sandbox/auto-story-v2/build.sh
# 构建、验收成功后才推送；此命令不会部署 Kubernetes：
PUSH=1 bash deploy/sandbox/auto-story-v2/build.sh
```

默认标签 `auto-story-v2-0.3.0`，可用 `REGISTRY` / `TAG` 指定输出，`BUILD_JOBS` 控制编译并发。也可用统一入口 `deploy/scripts/build-images.sh sandbox`。准备工具需要整个 `deploy/sandbox` 目录。

## 运行约束

- 完整继承 ACS ENTRYPOINT/CMD，不能替换 Jupyter 启动方式。
- `/home/user/workspace` 由 CSI 挂载；镜像不得预建该目录或软链。
- HOME、缓存、临时文件及用户依赖在沙箱本地，媒体输出写 Workspace。
- 凭证由运行时 Secret 注入，不进入构建上下文。
- `../sandboxset-auto-story-v2.yaml` 保留当前线上 digest。新镜像通过验收后才另行发布并更新 digest；修改构建源码不会切换线上镜像。

## 线上验收

从 `oma-server` 容器内用 stdin 运行 `verify-live.mjs`：创建独立 Workspace 前缀的临时沙箱，检查 CSI 挂载、读写与重连、镜像工具以及 launcher 已移除，最后清理文件并回收沙箱。设置 `VFS_DIAGNOSTIC_TASK_ID` 可额外重放一个已知 `DurationOutOfRange` 任务，验证普通与 `--once` 查询；不提交生成任务。
