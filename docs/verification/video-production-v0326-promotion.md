# video-production vfs-cli v0.3.26 镜像晋级

2026-11-19，agent-platform 集群，正式站点 `https://agentry.welltop.tech/api`，namespace `oma-infra`。用户明确授权复用已验收镜像、更新正式环境并添加镜像缓存；本次没有构建新镜像。

## 来源与目标

- 固定 Environment：`env_video_production`，保留 platform 所有者、ID、name/description/baseImage、env 和 encrypted secrets。
- 旧镜像：`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:3563f7b834e0fa4838680c56ff2d9a0a2d20ee5f912297593831fc6a6dd68ccf`，vfs-cli v0.3.24。
- 新镜像：`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:dbf59ec88fab71f49b2f62f9d5b19793fd370e428314c32b656f37a7e5fa9330`，vfs-cli v0.3.26。
- 来源测试 Environment：`env_IXivKfEC19lsu1r74GcZi`，成功 Build：`envb_YWrkUtxoT9Fg_-TEjunxE`。已在该镜像中真实生成 Mureka Resource 237858 和 Seedream 5.5 Resource 237834。
- 相同的基础镜像：`oma-sandbox@sha256:9a57f901b5df1aa280390b0256aac93c8e724aacb1f9f2831e9ccd441d90ac00`。manifest 的 baseImages/dpkg/pip/npm 相同，binaries 仅 vfs-cli 不同。

## 操作与一致性

生产缓存模式原已为 acs。通过正式 image-builder 的现有 AcsImageCaches.ensure 确认该 digest 的缓存就绪。确认没有 pending/running 构建后，暂停空闲 builder，使用平台运维权限在一个 PostgreSQL 事务中锁住目标环境并检查旧 image、last_build_id 和 init_script 快照，然后导入已验收镜像。

只更新 init_script、image、manifest、last_build_id、updated_at；事务内再次断言 env 和 secrets 未变化。新增 `envb_promote_vfs0326_2e2288e045dc` 作为镜像晋级来源记录，status=succeeded、attempts=0、retries=0。其平台构建日志明确标识“Existing-image promotion; no image build was run”，包含来源成功构建、原/新 digest 和缓存 ID，不伪造重新构建。

将正式定义通过 `oma-video-production-definition-9k69g6k6g7` ConfigMap 只读挂载到 builder 的 `/app/sandbox/environments/video-production`，然后恢复同一个 builder server image。挂载中的定义与事务写入的一致，因此启动没有排队重建。生产 Kustomize overlay 固化该挂载；ConfigMap 名含内容 hash。Runner/API Deployment 未改动，测试 overlay 不挂载这个定义。

## 缓存与预热池验证

- 缓存：`imc-uf6ct5vdrqmkaqlt66we`，state=Ready，名称按 `oma-production-<digest prefix>` 生成。
- builder 日志 `warm_pool_updated` 记录 `oma-sandbox` 从旧 digest 切到新 digest，并引用上述缓存。
- `sandbox-system/oma-sandbox` 最终 replicas=8、availableReplicas=8、updatedReplicas=8、updatedAvailableReplicas=8。
- 新 Pod `oma-sandbox-nsgtv` 的 `image.alibabacloud.com/matched-image-caches` 为 `[{"imageCacheId":"imc-uf6ct5vdrqmkaqlt66we","size":4}]`。

## 新 Sandbox 实测

正式站点新 Session `sess_GxZY-FAVCIzwA0u6Q3XEy` 绑定原 ID `env_video_production`。事件 seq 16 `span.sandbox_prepare_end` 显示新 digest、outcome=ready、swapped=false、claimMs=462、durationMs=709。新 Sandbox 为 `sandbox-system--oma-sandbox-j59n7`。

只读检查确认 `/usr/local/bin/vfs-cli` 为 v0.3.26；`schema generate image --model seedream-5.5-oversea` 和 `schema generate music --model mureka-9.5` 成功。没有在正式站点发起新的生成任务。27 项 builtin/部署环境配置测试通过。

## 回滚边界

旧环境 API 快照及旧 Deployment/SandboxSet 快照在运维主机留存。回滚需以同样顺序暂停空闲 builder，原子恢复旧 initScript/image/manifest/lastBuild，再恢复对应定义挂载并启动 builder。保留晋级历史及缓存，不删除业务资源。只切预热池或只改数据库脚本会被定义同步/镜像协调覆盖，不属于完整回滚。
