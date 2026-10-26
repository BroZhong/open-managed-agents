# oma-test ImageCache 自动创建启用与验证 — 2026-10-26

**结果：测试服已启用自动缓存，真实 builder 自动创建当前内置镜像的缓存并达到 Ready；新 Pod 实际命中，基础工具检查通过。** 本次只处理 ImageCache 配置及补建逻辑，原 Environments 审查发现的 4 个 P2 另见原报告。

## 部署与权限

- 源码修复提交：`d19ecc30655d`，分支 `codex/environments-review-regression`，已推送。
- 在 vfs-dev 的独立 checkout `~/workspace/yuzhong/oma-imagecache-20261026` 执行 `bash build.sh --push server`。
- 部署对象：`oma-test/oma-image-builder`；其镜像为 `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:38949f530044a9a291024a2c1fb945c434a624e8a6c14d27dd5162935750375d`。
- `WARM_POOL_IMAGE_CACHE=acs`；`WARM_POOL_ENVIRONMENT=env_video_production`；现有池为 `sandbox-system/oma-test-sandbox`。
- 新建专用 RAM 用户 `oma-test-image-cache`、策略 `OmaTestImageCacheCreateList`，仅授 `acc:CreateImageCache` 和 `acc:ListImageCaches`。
- 权限资源范围为本账号的 `acs:acc:cn-shanghai:<account-id>:imagecache/*`；这不是 IAM 层按 Kubernetes 测试命名空间隔离。没有授 Delete、RAM 管理或其他云服务权限。最终默认策略版本 v2，初始较宽的非默认版本 v1 已删除。
- 新建 `oma-test/oma-image-cache` Secret；凭据值只经内存传入 Kubernetes，未写入本地文件、报告或 Git。Deployment 原有 Secret 引用已生效。
- API/Runner/Web 未在本次更新。只修改测试 builder 的镜像及缓存开关，没有执行生产发布。

## 网络

沿用原配置并通过真实云 API 核对：Region `cn-shanghai`，安全组 `sg-uf6bikdzvy9di9y8wp89`，VPC `vpc-uf65tz56r2n9ofdsiwqtg`。

| vSwitch | 可用区 | 核对结果 |
| --- | --- | --- |
| `vsw-uf6kw2gmpn1psc4yqpgqa` | cn-shanghai-e | Available，同一 VPC |
| `vsw-uf6xsc4rp8k5cpjgcelmu` | cn-shanghai-f | Available，同一 VPC |
| `vsw-uf6x0tny2rxn2lffpc2ro` | cn-shanghai-l | Available，同一 VPC |

## 代码与配置变更

`WarmPoolUpdater` 现在先确保 ImageCache，再判断池镜像是否已经相同。首次启用缓存及缓存缺失时会补建；缓存 Ready 且镜像相同则不 patch 池。测试 overlay 默认启用 `acs`，部署说明补充凭据、资源权限及补建行为。

ACS 客户端协议未修改。核查发现 CLI 的 `biz-region-id` 是别名；官方 SDK 的 `RegionId`、POST `/`、RPC 查询编码与现实现一致，前期疑点已排除。

验证：新增补建用例在旧代码上失败，修复后 warm-pool/config 20 个测试通过；部署配置 16 个测试通过；API typecheck 与 `git diff --check` 通过。HTTP wire 测试还覆盖真实 signer 发出的 List/Create/List、NetworkConfig、Images、Tags、ClientToken 与 Ready 解析。

## 真实验证

所有下列时间为北京时间（UTC+8），原始 JSON 使用 UTC。

1. **接入专用身份**：收紧到上海地域资源 ARN 后，直接运行现有 ACS 客户端进行 List，成功返回当前镜像缓存 0 条。
2. **真实 builder 自动补建**：新 builder 于 15:01 启动，日志出现 `state=creating detail=created`；云端记录创建时间为 **15:01:24**。缓存名 `oma-test-490544134a0313d8`，ID `imc-uf6do32uk5dsbid1cj13`。验收脚本禁止调用 Create，创建由部署的 builder 完成。
3. **重启幂等**：缓存 Pending 期间重启 builder，重启后仍读取同一缓存 ID，缓存数量保持 1。一次 60 秒 rollout 等待先超时，随后检查确认 1/1 Ready，未发生容器崩溃。
4. **Ready 门控**：独立零副本 SandboxSet `oma-cache-test-gate-20261026` 最初使用旧镜像 `54d89827…`。真实 WarmPoolUpdater、ACS 客户端及 KubernetesWarmPool 配合受控 Environment store，共观察到 **16 次 Pending，镜像与 generation 不变、0 次 patch**；于 **15:04:50.768** 观察 Ready 后 patch 一次到 `49054413…`，再次 reconcile 为 unchanged。约 3 分 27 秒为创建到首次观测 Ready 的耗时。此项是受控集成验证，不冒充部署 builder 完成了一次全新的 Environment 镜像构建和切换。
5. **Pod 实际命中**：门控通过后，仅将独立测试池设为 1 副本。Pod `oma-cache-test-gate-20261026-mzhd8` 的 `matched-image-caches` 匹配 `imc-uf6do32uk5dsbid1cj13`，存在 **ImageCacheHit** 事件，运行镜像 digest 正确、Ready、restartCount=0。
6. **工具执行**：Pod 内实际执行成功，输出 Python 3.11.2、FFmpeg 9.0.1，OpenCV/NumPy 导入成功，退出码 0。
7. **运行状态**：原 `oma-test-sandbox` 的镜像、generation=3、resourceVersion 均与启用前相同；最终 builder 1/1 Ready，API health 正常，目标缓存唯一且 Ready。

新 Pod 从创建到主容器启动 39 秒。启用前已有 Pod 的对应历史样本为 76 秒；这里只记录单样本，不据此推导性能百分比或并发容量。

## 清理与保留

独立测试池以 UID 前置条件删除，**15:07:53** 确认其 SandboxSet、Sandbox、Pod 均为 0。没有新建业务 Session，也没有结束他人的 Session。

保留目标 ImageCache、专用 RAM 用户/策略和测试服 Secret，作为后续自动运行配置。旧缓存自动清理与终态失败缓存自动删除重建仍不在本次实现范围。

机器证据：[JSON](imagecache-enable-oma-test-2026-10-26.json)。本机完整脱敏记录及受控验收脚本在 `/tmp/oma-imagecache-enable-20261026/`，远端构建日志在 vfs-dev 的 `/tmp/oma-imagecache-build-20261026.log`。临时目录后续可能被系统清理。

原有功能审查见 [Environments 审查报告](environments-review-regression-oma-test-2026-10-26.md)。
