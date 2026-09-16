# auto-story-v2 镜像发布 — 2026-09-16

已部署到上海 `agent-platform` / `sandbox-system` 的 `auto-story-v2`。

- 镜像构建源码：`932d53ff`，分支 `codex/auto-story-v2-image`。
- 构建目录（vfs-dev）：`/root/workspace/yuzhong/oma-auto-story-v2-release-932d53f`。
- 镜像：`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-v2-932d53f`。
- 部署 digest：`sha256:90167310fe9a2d426dbaa89d97e845245456337fdd4fca0476c8cdbfaa407e2d`。
- 构建入口：`TAG=auto-story-v2-932d53f PUSH=1 bash deploy/sandbox/auto-story-v2/build.sh`，VFS_CLI_SRC 指向经版本锁校验的 Linux v0.3.16 二进制。
- 部署入口：`deploy/scripts/deploy-sandbox.sh --apply --confirm-production`。

## 变更

镜像直接从固定 ACS 基础 digest 构建。移除旧模板、历史 overlay、story-seed launcher；FFmpeg、Python 独立构建，CLI 按变更频率分层，APT/pip 使用 BuildKit 下载缓存。组件为 FFmpeg/ffprobe 9.0.1、google-genai 2.22.0、rg 15.1.0、fd 10.4.2、MediaKit 0.2.1、vfs-cli 0.3.16。

上线前热池为 0/1：模板强制引用 Secret 中不存在的 GEMINI_API_KEY / GEMINI_AUDIO_MODEL。已将这两个别名设为 optional；实际 GOOGLE_API_KEY / GEMINI_VIDEO_MODEL 配置保留，未修改 Secret 内容。上线后热池恢复。既有会话实例未重建，后续新建实例使用新镜像。

## 验证

- 部署测试 6 项通过，1 项可选集成测试跳过；Shell/Python/Node 语法及 Git diff 检查通过。
- 镜像内及容器离线验收 13 项全部通过：组件版本、Gemini SDK、Python 与基础科学包、原生搜索、VFS schema/dry-run、FFmpeg 编码与字幕、MediaKit 裁剪/拼接/字幕等。
- 原始 ACS ENTRYPOINT/CMD 与基础镜像一致，Jupyter 健康检查通过。
- 同一 builder 重复构建 18 步命中缓存，构建加离线验收共 11 秒；这是暖缓存实测，不代表冷构建速度。
- 实际生产网关创建临时沙箱：CSI Workspace 挂载、文件读写、重连、工具验收、launcher 已移除全部通过。
- 使用 Host 正常的 base-secret 注入路径，查询已有任务 `audio_f0a32ae6-7afe-4624-b360-b4379336ee8e`，普通与 `--once` 都返回 `DurationOutOfRange`。只重放任务结果，无新生成或额外生成费用。
- 临时 Workspace 文件和测试沙箱已清理，原有运行会话保持。

验收脚本维护在 `deploy/sandbox/auto-story-v2/verify-live.mjs`。CLI 失败 JSON 位于 stderr；该脚本合并输出后校验 error envelope。

## ImageCache 启用与复测

为主镜像的相同 digest 创建上海 ACS ImageCache `imc-uf6fba9qbhsjywolg2pj`，名称 `oma-auto-story-v2-90167310`，状态 Ready，平台报告 4 GiB。使用当前集群交换机及安全组，通过 VPC 拉取，不创建 EIP。生产模板已开启 `image.alibabacloud.com/enable-image-cache: "true"`，预热数量仍为 1；镜像未重新构建。

用相同镜像、2 CPU / 4 GiB、相同 CSI Workspace 配置、预热数为 0 的临时模板测试三次。从 Sandbox.create 开始到首条命令完成分别为 26.250、28.313、27.795 秒，平均 27.453 秒；Workspace 写读删除完成分别为 26.887、28.741、28.191 秒。此前无缓存的三次冷启动平均 77.946 秒，此次缩短约 64.8%。每次均有 `ImageCacheHit` 事件，主镜像显示 already present on machine；测试模板及沙箱已删除。

启用后的实际生产测试沙箱 `auto-story-v2-rv47k` 同样记录 ImageCacheHit，完整工具与 Workspace 验收、普通/once 的 DurationOutOfRange 结果重放均通过。文件和测试沙箱已清理，生产热池 1/1，API health 为 ok。

当前只缓存主镜像，三个 runtime/CSI 辅助镜像仍按原路径拉取。缓存成本按 4 GiB 和使用该缓存的 Pod 全生命周期计费：按 2026-09-16 官方单价，4 × 0.00231 元/小时，单个 Pod 持续运行 30 天约 6.65 元；地域前 20 个缓存的存储免费。后续发布新 digest 时需先制作对应缓存，旧缓存清理前需确认是否仍有保留镜像或回滚需求。

参考：[ACS ImageCache 使用与计费](https://help.aliyun.com/zh/cs/user-guide/accelerate-acs-pod-startup-using-image-caching)。
