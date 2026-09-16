# Sandbox

当前唯一维护的模板是 **auto-story-v2**（上海 agent-platform，namespace `sandbox-system`）。

- [镜像构建与缓存设计](auto-story-v2/README.md)
- [当前 SandboxSet](sandboxset-auto-story-v2.yaml)
- [OSS Workspace 存储配置与验收](oss-workspace/README.md)

`deploy/scripts/build-images.sh sandbox` 构建镜像；`deploy/scripts/deploy-sandbox.sh` 默认只做服务端 dry-run。构建、推送与部署是独立步骤。旧 `auto-story`、`code-interpreter-vfscli`、`search-tools` 构建目录及 workspace overlay 已移除，所需能力统一在 auto-story-v2 中维护。
