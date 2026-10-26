# 云端 Agent 平台如何让用户自定义沙箱依赖与镜像

调查日期：2026-10-25。

本文调研主流云端 Agent 平台和沙箱基础设施怎样让用户定制沙箱的依赖或镜像。每个平台回答五个问题：能定制什么；安装何时执行、怎么缓存；安装阶段有没有 root、网络策略是否与运行阶段不同；对基础镜像有什么约束、平台升级基础镜像时怎么办；密钥在安装阶段是否可用。只采用官方文档、官方 changelog 和官方仓库源码。最后一节把行业做法对照到 OMA 的第一阶段方案。

**版本/来源基线**（源码链接固定到下列 commit）：

| 对象 | 版本或读取对象 |
|---|---|
| Claude Managed Agents | beta header `managed-agents-2026-04-01`；anthropic-sdk-python `202db72`（2026-10-23） |
| Claude Code on the web | code.claude.com `cloud-environments` 页 |
| OpenAI Codex cloud | 新版 `environments/cloud-environments`（页面发布于 2026-10-24）与 Legacy 页；openai/codex-universal `47f4f0e`（2026-05-02） |
| Cursor Cloud Agents | `cloud-agent/setup`、`builds`、`security-network`；`environment.schema.json`（2026-10-25 读取） |
| GitHub Copilot cloud agent | docs.github.com（经 `docs.github.com/api/article/body` 读取正文） |
| Google Jules | `jules.google/docs/environment` 与 changelog |
| Devin | `docs.devin.ai` blueprints / blueprint-reference / security-profiles |
| OpenHands | docs.openhands.dev；OpenHands/software-agent-sdk `7234ea2`（2026-10-25） |
| E2B | e2b-dev/E2B `a2b2cae`（2026-10-24，js-sdk 2.59.0） |
| Daytona | daytona.io/docs `snapshots`、`declarative-builder`、`isolation` |
| Cloudflare Sandbox SDK | cloudflare/sandbox-sdk `643233e`（2026-10-22，package 1.0.3） |
| 阿里云无影 AgentBay | agentbay-ai/wuying-agentbay-sdk `8e2fa8f`（2026-06-04）；aliyun/agentbay-cli `23a5b95`（2026-08-03） |
| Modal / Vercel Sandbox | Modal Python SDK 1.6.2 文档；Vercel `sandbox/concepts/images`（last_updated 2026-08-11） |

**阅读约定**：
- 标 `推断` 的内容，是从源码、示例或文档结构推出、文档没有明说的结论。
- 标 `[unverified]` 的内容，没有找到一手依据。
- platform.claude.com 在本机所在地区会被 307 到 app-unavailable 页面，developers.cloudflare.com 在本机 TLS 握手失败。这两处文档都用 `r.jina.ai` 读取页面文本，文中链接仍指向官方页面。其他站点通过官方 `llms.txt` 索引或 `.md` 版本读取。

## 结论摘要

1. **定制形式分三档：越接近产品，越偏向"脚本 + 快照"；越接近基础设施，越偏向"镜像/模板"。**
   - 面向终端用户的 Agent 产品（Claude Code on the web、Codex、Jules、Copilot、OpenHands Cloud）只开放 setup script，不能替换基础镜像。Claude Code 文档原话："Replacing the base image entirely isn't supported yet"（[cloud-environments](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook)）。
   - Cursor 和 Devin 在脚本之外加了"Build → 快照"流水线。Cursor 还允许 Dockerfile、镜像引用或快照作为 base。
   - 沙箱基础设施（E2B、Daytona、Cloudflare、Vercel、Modal、AgentBay）把镜像/模板当作一等公民。
   - 只有 Claude Managed Agents 提供纯声明式包列表（`apt/cargo/gem/go/npm/pip`），由平台代为安装。
2. **主流做法是装一次、快照复用，缓存按配置内容失效，再用时间 TTL 兜底。快照只保留磁盘，不保留进程。**
   - Claude Code：setup 完成后对文件系统做快照；脚本或允许的主机变化时重建，约 7 天过期。
   - Codex Legacy：容器状态最多缓存 12 小时，脚本、env、secret 任一变化即失效。新版 Codex 在 Publish 时捕获已准备好的文件系统。
   - Cursor 和 Devin：配置或密钥变化触发 Build；另有周期性重建（Devin 约 24 小时一次）。
   - 每次会话都重跑安装的只有 OpenHands 的 `.openhands/setup.sh` 和 Copilot 的 setup steps。
3. **安装阶段几乎都能拿到 root；有几家明确在运行阶段降为普通用户。**
   - Claude Code 的 setup script 明确以 root 运行。Copilot 运行在免密 sudo 的 Actions runner 上。AgentBay 要求 Dockerfile 以 `USER root` 结尾。
   - OpenHands 运行时用户是 `openhands`（UID 10001），带免密 sudo。E2B 默认用户是 `user`，构建步骤可以按层指定 `root`。
4. **安装和运行两阶段的网络策略，只有少数平台明确分开。**
   - 分开的：Codex Legacy 的 setup 阶段有网，agent 阶段默认断网；Copilot 的防火墙不作用于 setup steps 启动的进程。
   - 不分开的：Claude Code、Cursor、Managed Agents 两阶段共用同一套策略。Managed Agents 只要声明了 `packages`，就必须设 `allow_package_managers: true`，结果是注册表和 github.com 等主机也对 agent 开放。
5. **"安装用的密钥不进 agent 阶段"是共识方向，但实现各不相同。**
   - Codex Legacy：secrets 只给 setup script，agent 阶段开始前移除。
   - Cursor：Build Secret 只给 Docker build；User secret 只在 agent 启动时注入，不进 Build。
   - Devin：secrets 在保存快照前擦除，但被写进配置文件的值会留在快照里。
   - Claude Code：network secret 不附加到 setup script 发出的请求上，环境变量在 setup 时也还没设置。
   - Copilot 和 OpenHands 不区分阶段。
6. **只要允许自带镜像，就有一份运行时契约。平台升级时的处理分三类。**
   - 必须基于官方镜像：OpenHands 要求 FROM agent-server 镜像且不能覆盖 entrypoint；AgentBay 的 Dockerfile 模板前 N 行由系统锁定。
   - 平台把运行时注入任意镜像：Cloudflare 1.0 从 donor 镜像 COPY 静态链接的 `sandbox-shim`，镜像 tag 必须等于 SDK 版本；E2B 在构建时做 provisioning；Vercel 不运行镜像的 `ENTRYPOINT/CMD`。
   - 显式的版本兼容机制：OpenHands 整体前后兼容，个别特性设最低版本；Modal 用工作区级 Image Builder Version，让用户自己选时间升级。
7. **失败语义分化明显。**
   - Claude Code：setup script 非零退出，会话直接起不来。
   - Copilot：跳过剩余步骤，带着残缺环境继续工作。
   - Cursor/Devin：失败的 Build 不会替换当前生效的快照；Devin 还有 Partial 状态。
   - Managed Agents：在配置层校验，例如缺 `allow_package_managers` 直接返回 400。
8. **越来越多平台让 agent 自己配置环境，但最终沉淀的仍是可审阅的配置。**
   - Codex 新版、Cursor、Devin、Jules 都由 agent 探测仓库、安装并验证，再保存或发布快照。
   - 沉淀物仍是可审阅的 install script、blueprint、Dockerfile 或 `environment.json`。

## 1. Claude Managed Agents

- **能定制什么**：
  - 在 environment 的 `config.packages` 里按包管理器列包名，支持 `apt/cargo/gem/go/npm/pip`。版本写法沿用各包管理器的原生语法（`sqlalchemy==2.0.30`、`express@4.18.0`、`rails:7.1.0`）。不支持 setup script 和自定义镜像。要用自己的镜像只能走 self-hosted sandbox，由用户的 worker 提供（[environments](https://platform.claude.com/docs/en/managed-agents/environments#packages)、[choosing-an-environment](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment)）。
  - SDK 类型 `BetaPackages` 就是六个 `List[str]` 字段加可选的 `type: "packages"`（[beta_packages.py@202db72](https://github.com/anthropics/anthropic-sdk-python/blob/202db72c87d7c6eaa72129c67ce67fd343a3a20c/src/anthropic/types/beta/beta_packages.py)）。
  ```json
  "config": {"type": "cloud",
    "packages": {"pip": ["pandas", "numpy", "scikit-learn"], "npm": ["express"]},
    "networking": {"type": "limited", "allow_package_managers": true}}
  ```
- **何时执行、怎么缓存**：
  - "pre-installs packages into the sandbox before the agent starts"，并且 "cached across sessions that share the same environment"。
  - 多个包管理器按字母序执行（apt, cargo, gem, go, npm, pip）。未钉版本的包装最新版。
  - environment 没有版本，文档建议用户自己记录配置变更（[environments#environment-lifecycle](https://platform.claude.com/docs/en/managed-agents/environments#environment-lifecycle)）。缓存的失效规则 `[unverified]`。
- **root 与网络**：
  - 安装身份 `[unverified]`；能装 apt 包，`推断` 安装由平台以特权身份执行。
  - 网络只有一套 `networking` 配置。`limited` 模式下声明 `packages` 必须设 `allow_package_managers: true`，否则返回 400。打开后，PyPI、npm、github.com 等主机对整个 sandbox 开放，agent 阶段也能访问。
  - 文档提醒，网络是按主机放行、不按操作放行，`git push` 和发布包都可能成功（[environments#networking](https://platform.claude.com/docs/en/managed-agents/environments#networking)）。
- **基础镜像约束**：
  - 固定为 Ubuntu 24.04 x86_64，预装多语言运行时和常用库（[cloud-sandboxes-reference](https://platform.claude.com/docs/en/managed-agents/cloud-sandboxes-reference)）。
  - 文档对 Playwright 有专门提醒：要用预装版本，因为另装的版本会去找一个并不存在的浏览器构建。
  - 平台升级基础镜像时，用户的包列表怎么处理 `[unverified]`。
- **密钥**：vault 的 `environment_variable` 凭证在 sandbox 里只是占位符，出口时才替换成真值（[vaults](https://platform.claude.com/docs/en/managed-agents/vaults)）。这对 `packages` 安装是否生效 `[unverified]`。

## 2. Claude Code on the web

- **能定制什么**：
  - environment 级的 Bash setup script（≤64 KB）、`.env` 格式的环境变量、network secret 和网络访问级别。
  - 也可以在仓库的 `.claude/settings.json` 里配 SessionStart hook，这种方式每次会话都跑。
  - 不能替换基础镜像；需要别的镜像时，可以用 `docker compose` 在旁边起一个容器（[cloud-environments](https://code.claude.com/docs/en/cloud-environments#setup-scripts)）。
- **何时执行、怎么缓存**：
  - 首次在某个 environment 里开会话时，setup script 在 Claude Code 启动前运行。如果能在约 5 分钟内完成，平台对文件系统做快照，之后的会话直接从快照启动，跳过脚本。
  - 改脚本、改允许的主机、或缓存到期（约 7 天）时，脚本重跑以重建缓存。
  - 快照只保留磁盘内容，不保留进程；会话中途装的包不会带到其他会话（[#environment-caching](https://code.claude.com/docs/en/cloud-environments#environment-caching)）。
  - 基础镜像升级是否让缓存失效 `[unverified]`。
- **root 与网络**：
  - 原话："Scripts run as root on Ubuntu 24.04"。
  - 网络有 None/Trusted/Full/Custom 四级，setup 和 agent 共用；选 None 时安装会失败（[#script-requirements](https://code.claude.com/docs/en/cloud-environments#script-requirements)）。
  - 所有出站流量都经过安全代理，Bun 已知与代理不兼容。
- **基础镜像约束**：平台镜像预装多语言运行时、Docker、PostgreSQL 和 Redis（[#installed-tools](https://code.claude.com/docs/en/cloud-environments#installed-tools)）。
- **密钥**：
  - setup script 运行时，environment 的环境变量还没设置。
  - network secret 由 agent proxy 在请求离开 VM 后才附加，并且明确不附加到 setup script 的请求上，因为 proxy 在 setup 结束后才连上（[#requests-that-never-get-the-secret](https://code.claude.com/docs/en/cloud-environments#requests-that-never-get-the-secret)）。

## 3. OpenAI Codex cloud

- **能定制什么**：
  - Legacy 版：setup script、可选的 maintenance script、环境变量、secrets，以及用 "Set package versions" 钉住运行时版本。基础镜像固定为 `universal`，[codex-universal](https://github.com/openai/codex-universal/blob/47f4f0eb5337083e2f610db0d15558932cb4901d/README.md) 只是参考实现，"not an identical environment"（[Legacy environments](https://developers.openai.com/codex/environments/cloud-environment)）。
  - 新版：由 agent 探测仓库、安装并测试，结果记录为 "Install script" 和 "Start skill"；Publish 时 "captures the prepared filesystem"（[cloud-environments](https://developers.openai.com/codex/environments/cloud-environments)）。
- **何时执行、怎么缓存**：
  - Legacy：容器状态最多缓存 12 小时。建缓存时检出默认分支并运行 setup；复用缓存时先切到任务分支，再运行 maintenance script。改 setup 脚本、maintenance 脚本、env 或 secrets 都会自动让缓存失效；也可以手动 Reset cache。Business 和 Enterprise 的缓存由整个工作区共享。
  - 新版：新任务从已发布的文件系统启动；后台的 repository refresh 保留依赖缓存，不重跑安装。
- **root 与网络**：
  - root：codex-universal 参考镜像 `FROM ubuntu:24.04`、`HOME=/root`，没有 `USER` 指令（[Dockerfile#L2-L8](https://github.com/openai/codex-universal/blob/47f4f0eb5337083e2f610db0d15558932cb4901d/Dockerfile#L2-L8)），`推断` setup 以 root 运行。
  - 网络（Legacy）："Setup scripts run with internet access. Agent internet access is off by default"。agent 阶段可以按域名白名单放行，还能只允许 GET/HEAD/OPTIONS（[internet-access](https://developers.openai.com/codex/cloud/internet-access)）。
  - 网络（新版）：环境级白名单（Package managers 预设、自定义域名、全开）同时作用于 setup 和任务。
  - setup 与 agent 在不同的 Bash 会话里，`export` 带不到 agent 阶段。
- **基础镜像约束**：只能用 `universal`，runtime 版本只能从支持列表里选（`CODEX_ENV_*`）。平台升级时缓存怎么处理 `[unverified]`。
- **密钥**：
  - Legacy："secrets are removed before the agent phase starts"；环境变量则贯穿两个阶段。
  - 新版改为 network secret：程序只拿到占位符，proxy 在 setup 和任务阶段都会对允许的 HTTPS 目的地做替换。

## 4. Cursor Cloud Agents

- **能定制什么**：
  - `.cursor/environment.json`，或 dashboard 里保存的 environment。base 可以是 `build`（Dockerfile）、`image`（镜像引用）或 `snapshot` 三者之一，再加上 `install`、`start`、`terminals`、`user` 和 egress 设置。
  - schema 里有 `agentCanUpdateSnapshot`：对 snapshot 或默认 base 默认为 true，对 Dockerfile 或 image base 总是 false（[environment.schema.json](https://www.cursor.com/schemas/environment.schema.json)）。
  - 推荐由 agent 自己完成环境配置（[setup](https://cursor.com/docs/cloud-agent/setup)）。
  ```json
  {"build": {"dockerfile": "Dockerfile", "context": ".."}, "install": "pnpm install && ./custom_script.sh"}
  ```
- **何时执行、怎么缓存**：
  - `install` 只在 Build 时运行：从 base 出发，克隆默认分支，跑完 install，快照磁盘，然后切为当前生效的 Build。
  - `start` 和 `terminals` 在每次 agent 启动时运行。
  - Build 的触发条件：周期检查（没有新 commit、配置和密钥也没变则跳过）、保存配置或改密钥、手动、agent 请求。
  - install 必须幂等；超时默认 90 分钟，可设 5–300 分钟。
  - Build 失败不会替换当前生效的 Build（[builds](https://cursor.com/docs/cloud-agent/builds)）。
  - Dockerfile 用层缓存。环境快照连续 30 天没人用就删除（[security-network](https://cursor.com/docs/cloud-agent/security-network)）。
- **root 与网络**：
  - 官方 Dockerfile 示例创建 `ubuntu` 用户，并配置 `NOPASSWD` sudo。install 以哪个用户运行 `[unverified]`；schema 的 `user` 字段可以指定运行用户。
  - 网络有全开、Default+allowlist、Allowlist only 三种模式，按用户、environment、团队三级配置。文档写 Build "use ... network settings"，`推断` 两阶段共用同一套策略。
- **基础镜像约束**：
  - Dockerfile 可以换 OS；但 Computer Use 只支持 Debian/Ubuntu 系。
  - 不要 `COPY` 整个项目，工作区由 Cursor 检出。
  - 首次 Build 成功之前，agent 用 Cursor 默认镜像启动。
- **密钥**：
  - Team secret 和 environment secret 在 Build 时可用。User secret "aren't available during Builds and don't become part of a shared snapshot"。
  - Build Secret 只给 Docker build，用 `RUN --mount=type=secret` 读取。
  - Runtime Secret 在 agent 的输出里被替换成 `[REDACTED]`。

## 5. GitHub Copilot cloud agent

- **能定制什么**：在 `.github/workflows/copilot-setup-steps.yml` 里写唯一一个 job，名字必须是 `copilot-setup-steps`。只认 `steps`、`permissions`、`runs-on`、`services`、`snapshot`、`timeout-minutes`（≤59）这几个字段。`runs-on` 可以指定 larger runner、自托管 ARC runner 或 Windows（[customize-the-agent-environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)）。
  ```yaml
  jobs:
    copilot-setup-steps:
      runs-on: ubuntu-latest
      steps: [{uses: actions/checkout@v6}, {run: npm ci}]
  ```
- **何时执行、怎么缓存**：
  - 每次 Copilot 开始工作前，都在临时 runner 上跑一遍；文件只有在默认分支上才生效。
  - 加速靠 `actions/cache`、`setup-node` 的 cache 参数，或者用 `snapshot` 关键字生成 GitHub Actions 自定义镜像（每次成功运行产生一个新版本，有过期策略，[use-custom-images](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/use-custom-images)）。
  - 失败语义："If any setup step fails ... Copilot will skip the remaining setup steps and begin working with the current state"。
- **root 与网络**：
  - GitHub 托管的 Linux runner "run using passwordless `sudo`"（[github-hosted-runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)）。
  - agent 防火墙"only applies to processes started by the agent via its Bash tool"，不覆盖 setup steps 启动的进程（[customize-the-firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall)）。等于安装阶段不受防火墙限制。
- **基础镜像约束**：只支持 Ubuntu x64 和 Windows x64 runner。自定义镜像可以从 GitHub 官方镜像起步，也可以从干净的 OS 起步。
- **密钥**：Agents 类型的 secrets 和 variables 以环境变量形式同时给 setup steps 和 agent；只有 `COPILOT_MCP_` 前缀的只给 MCP（[configure-secrets-and-variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables)）。两个阶段不区分。

## 6. Google Jules

- **能定制什么**：仓库级 setup script。简单项目由 Jules 参考 `AGENTS.md` 和 README 自行准备环境（[environment](https://jules.google/docs/environment)）。
- **何时执行、怎么缓存**：用户点 "Run and Snapshot"，脚本成功后生成快照，此后该仓库的任务都从快照启动（2025-08-05 changelog，[changelog](https://jules.google/docs/changelog/)）。快照的失效规则 `[unverified]`。setup script 里不能跑长驻进程（[faq](https://jules.google/docs/faq/)）。
- **root 与网络**：VM 是 Ubuntu，预装工具的路径在 `/home/jules` 下，`推断` 默认以非 root 用户运行；有没有 sudo `[unverified]`。FAQ 说 VM "with internet access"；两个阶段是否区分 `[unverified]`。
- **基础镜像约束**：只能用平台镜像，不能换。
- **密钥**：仓库级环境变量，在开任务时选择启用，"Task-Long Access"（2025-10-01 changelog）。setup 阶段是否可见 `[unverified]`。

## 7. Devin

- **能定制什么**：
  - 用 YAML blueprint 描述环境，分企业、组织、仓库三级，逐级叠加。字段有 `initialize`、`maintenance`、`knowledge`，以及 `post-build`（仅组织和企业级）、`clone`（仅仓库级）。
  - 步骤里可以直接引用 GitHub Actions；blueprint 也可以放在 `.devin/blueprint.yaml` 里用 git 管理。
  - 推荐让 Devin 自己生成 blueprint（[blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints)）。
  ```yaml
  initialize: |
    curl -LsSf https://astral.sh/uv/install.sh | sh
  maintenance: |
    uv sync
  ```
- **何时执行、怎么缓存**：
  - Build 依次执行企业、组织、仓库各级的 initialize 和 maintenance，再执行 post-build 和健康检查，最后产出组织唯一的 active snapshot。每个会话启动一份全新拷贝。
  - 会话启动时，maintenance 命令只作为上下文提供给 agent，不自动执行。
  - 触发 Build 的情况：保存 blueprint、增删仓库、新增仓库 secret、手动、约 24 小时一次的周期刷新。
  - 单步超时 3 小时。可以 pin 到 7 天内的某次 Build。仓库级步骤失败时 Build 记为 Partial，快照仍然可用。
- **root 与网络**：
  - 文件路径是 `/home/ubuntu`，官方模板里大量用 `sudo apt-get`（[templates](https://docs.devin.ai/onboard-devin/environment/templates)），`推断` 是普通用户加免密 sudo。
  - Security profile 的网络 allowlist 作用于会话里的所有流量，包括装包（[security-profiles](https://docs.devin.ai/product-guides/security-profiles)）。是否同样约束 Build `[unverified]`。
- **基础镜像约束**：只能用平台 VM 镜像，不能换。
- **密钥**：
  - secrets 在 Build 和会话中都以环境变量形式出现，保存快照前从镜像里擦除。
  - 但 initialize 或 maintenance 写进配置文件（如 `~/.npmrc`）的值会留在快照里；文档建议把写凭证的步骤放进 maintenance，让周期 Build 刷新。
  - 企业级 secret 可以标记为 Build only：克隆仓库前移除，也不注入会话（[blueprint-reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference)）。

## 8. OpenHands（Cloud / Enterprise）

- **能定制什么**：
  - 仓库里的 `.openhands/setup.sh`（[repository](https://docs.openhands.dev/openhands/usage/customization/repository)）。
  - Enterprise 可以用自定义 sandbox 镜像：每个镜像对应一个 warm pool，用户在设置里选默认镜像，也可以在 API 里用 `sandbox_spec_id` 为单个会话指定（[custom-sandbox-images](https://docs.openhands.dev/enterprise/custom-sandbox-images/index)、[using-custom-images](https://docs.openhands.dev/enterprise/custom-sandbox-images/using-custom-images)）。SaaS 版能否自定义镜像 `[unverified]`。
- **何时执行、怎么缓存**：
  - setup.sh "will run every time OpenHands begins working with your repository"，没有快照缓存。
  - 自定义镜像靠预烘焙依赖加 warm pool 提速。warm pod 只有在镜像、命令、env、`run_as_user` 等完全匹配时才会被认领；配置改动后约 1 分钟内旧 pod 不再匹配。
- **root 与网络**：
  - 运行时用户是 `openhands`（UID 10001），base image 阶段给它配了 `NOPASSWD:ALL`（[Dockerfile#L446-L447@7234ea2](https://github.com/OpenHands/software-agent-sdk/blob/7234ea255143fcff622afe598f50a1651ef80903/openhands-agent-server/openhands/agent_server/docker/Dockerfile#L446-L447)）。
  - 官方示例 Dockerfile 先 `USER root` 装系统包，再切回 `openhands`。
  - 网络策略 `[unverified]`。
- **基础镜像约束**：
  - 必须 `FROM ghcr.io/openhands/agent-server:<tag>`，保留 entrypoint `tini -- openhands-agent-server`，"extend, do not replace"。
  - 版本"largely forward and backward compatible"，只有少数特性设了最低版本，不满足时报 `AGENT_SERVER_VERSION_TOO_OLD`。
  - 建议每次 Enterprise 升级时刷新 base tag；需要频繁更新的部分放进镜像内的 `prepare-*` 脚本（[building-custom-images](https://docs.openhands.dev/enterprise/custom-sandbox-images/building-custom-images)）。
- **密钥**：Settings > Secrets 里的值全部作为环境变量导出到运行时，不分阶段（[secrets-settings](https://docs.openhands.dev/openhands/usage/settings/secrets-settings)）。文档明确禁止把 secret 烘焙进镜像。

## 9. E2B

- **能定制什么**：
  - 用 Template SDK 或 Dockerfile（`fromDockerfile`）定义模板，base 可以是任意镜像（`fromImage`），也可以是已有模板（`fromTemplate`）。
  - 提供 `pipInstall`、`npmInstall`、`aptInstall` 等声明式 helper，以及 `setStartCmd`/ready 命令（[defining-template](https://docs.e2b.dev/template/defining-template)、[base-image](https://docs.e2b.dev/template/base-image)）。
  - 运行中的 sandbox 也可以做快照，再从快照创建新 sandbox（见 [agent-sdk-sandbox-toolcall-architecture.md](./agent-sdk-sandbox-toolcall-architecture.md) §9）。
- **何时执行、怎么缓存**：
  - 依赖在构建时安装。构建结束时执行 start 命令、等待就绪，然后对整个 sandbox（包括正在运行的进程）做快照，这就是模板；之后创建 sandbox 时进程已经在跑（[start-ready-command](https://docs.e2b.dev/template/start-ready-command)）。
  - 层缓存按"命令 + 输入"作为键，可以用 `skipCache` 或 `forceUpload` 失效（[caching](https://docs.e2b.dev/template/caching)）。
- **root 与网络**：
  - 默认用户是 `user`。全局 `pipInstall` 和 `aptInstall` 在源码里以 `user: 'root'` 执行（[index.ts#L764-L853@a2b2cae](https://github.com/e2b-dev/E2B/blob/a2b2caea4498766aee8fd33d3280b56744070e99/packages/js-sdk/src/template/index.ts#L764-L853)）。
  - 运行时默认可以出网，可按 sandbox 配置开关或 allow/deny 列表（[internet-access](https://docs.e2b.dev/network/internet-access)）。构建阶段的网络策略 `[unverified]`。
- **基础镜像约束**：
  - 需要能从 `/etc/os-release` 识别发行版（Debian/Ubuntu、Fedora/RHEL、Arch、Alpine），scratch 和 distroless 不支持。
  - 平台在构建时 "do provisioning and configuration"（[how-it-works](https://docs.e2b.dev/template/how-it-works)），`推断` 平台运行时在构建时注入，用户镜像不需要自带。
  - 内核版本取决于模板的构建日期，`推断` 平台升级的成果要靠重建模板才能拿到。
- **密钥**：E2B Secrets 由出口代理注入到匹配的出站请求里（[secrets](https://docs.e2b.dev/secrets)）；`setEnvs` 设置的变量会写进模板。构建时专用密钥 `[unverified]`。

## 10. Daytona

- **能定制什么**：
  - 从任意 registry 镜像创建 snapshot，必须带 tag 或 digest，不支持 `latest/lts/stable`。
  - 也可以用 Declarative Builder（`pip_install`、`run_commands` 等）声明镜像。
  - 还可以对 sandbox 做 snapshot，容器类只保留文件系统（[snapshots](https://www.daytona.io/docs/en/snapshots)、[declarative-builder](https://www.daytona.io/docs/en/declarative-builder)）。
- **何时执行、怎么缓存**：
  - 依赖在构建时安装。声明式镜像缓存 24 小时，同一 runner 上复用。
  - snapshot 两周不用会变为 inactive，需要重新激活。可以配置 warm pool。
- **root 与网络**：
  - 文档建议先以 root 安装，再创建非 root 用户并切换。
  - 运行时出网按 tier 默认开放或受限，单个 sandbox 可设 block all、CIDR 或域名白名单（[isolation](https://www.daytona.io/docs/en/isolation)）。
  - 构建阶段的网络策略 `[unverified]`。
- **基础镜像约束**：
  - 可以用任意镜像；VM 类 sandbox 不支持 Dockerfile 或声明式构建。
  - 平台怎样把自己的 daemon 放进用户镜像 `[unverified]`。
- **密钥**：构建时专用密钥 `[unverified]`；私有 registry 凭证单独配置。

## 11. Cloudflare Sandbox SDK

- **能定制什么**：
  - 用自己的 Dockerfile，`wrangler deploy` 时构建并推送。
  - 1.0 的要求是镜像里有 `/usr/local/bin/sandbox-shim`，从 tag 与已安装 `@cloudflare/sandbox` 版本一致的 donor 镜像 COPY 进来。这个 helper "is a statically linked `linux/amd64` binary. It runs in any `linux/amd64` image"（[reference#requirements](https://developers.cloudflare.com/sandbox/reference/)）。
  - 官方甚至给了 Pi 的示例镜像：`node:26-bookworm-slim` + `npm i -g @earendil-works/pi-coding-agent` + COPY shim（[examples/coding-agents/pi/Dockerfile@643233e](https://github.com/cloudflare/sandbox-sdk/blob/643233e5159d5d9d184f50196c8294f451745004/examples/coding-agents/pi/Dockerfile)）。
  - [Dockerfile reference](https://developers.cloudflare.com/sandbox/configuration/dockerfile/) 页仍以 0.12.14 为例：`FROM docker.io/cloudflare/sandbox:<ver>`，或者从官方镜像 COPY `/sandbox` 二进制。
- **何时执行、怎么缓存**：依赖在构建时安装，用 Docker 层缓存。没有运行期包安装机制。
- **root 与网络**：Dockerfile 的 `RUN` 默认以 root 执行。运行期网络按容器启动参数控制（`enableInternet`，见 [README@643233e](https://github.com/cloudflare/sandbox-sdk/blob/643233e5159d5d9d184f50196c8294f451745004/README.md)）。
- **基础镜像约束**：
  - 不要求基于官方镜像，只要求 shim。
  - SDK 与 shim 之间的帧协议带版本字节，没有协商，版本不符直接报错。donor 镜像的 tag 与 package 版本绑定，用来保证两边同步（[shim-protocol.md#L129-L135](https://github.com/cloudflare/sandbox-sdk/blob/643233e5159d5d9d184f50196c8294f451745004/docs/shim-protocol.md#L129-L135)）。
  - `DirectoryBackup` 可以把目录恢复到"including one on a newer image"的容器里。
- **密钥**：构建时密钥 `[unverified]`。

## 12. 阿里云无影 AgentBay

- **能定制什么**：
  - 控制台方式：为 Computer Use（Windows/Linux）和 Mobile Use 创建自定义镜像，Browser Use 不支持。
  - CLI 方式：只支持 CodeSpace。流程是 `agentbay image init -i <系统镜像>` 下载 Dockerfile 模板，本地 `docker build` 后推到 AgentBay ACR，再执行 `image create-from-template` 和 `image activate`（[custom-images.md@8e2fa8f](https://github.com/agentbay-ai/wuying-agentbay-sdk/blob/8e2fa8f20981c826eb5d247bc6701d52570e104a/docs/guides/common-features/advanced/custom-images.md)、[image-workflow.md@23a5b95](https://github.com/aliyun/agentbay-cli/blob/23a5b95951a638d29ddfd20b186bd8584c720dbb/docs/zh/image-workflow.md)）。
- **何时执行、怎么缓存**：在用户本地构建，镜像激活需要 1–2 分钟。会话通过 `image_id` 选择镜像。
- **root 与网络**：
  - Dockerfile "末尾**必须**包含 `USER root`，或者全程未指定 `USER`"。
  - 激活时选择网络类型 DEFAULT、ADVANCED 或 CUSTOMIZED（VPC）。构建在用户本地，构建阶段的网络由用户自己决定（[image.md#L204-L212](https://github.com/aliyun/agentbay-cli/blob/23a5b95951a638d29ddfd20b186bd8584c720dbb/docs/zh/image.md#L204-L212)）。
- **基础镜像约束**：
  - 模板的前 N 行由系统定义，不可修改；不能改 `FROM`，不能写 `CMD`；只支持 Linux x86。
  - 需要 entrypoint 时，改写成 supervisor 配置（[image.md#L126-L133](https://github.com/aliyun/agentbay-cli/blob/23a5b95951a638d29ddfd20b186bd8584c720dbb/docs/zh/image.md#L126-L133)）。
  - 系统镜像 `*_latest` 会自动更新，可能与旧版 SDK 的 API 不兼容，所以官方建议生产环境用版本固定的自定义镜像。
- **密钥**：本地构建，构建时密钥由用户自行处理；平台侧 `[unverified]`。

## 13. 其他（简述）

| 平台 | 要点 |
|---|---|
| **Modal** | `Image` 链式定义（`pip_install`、`apt_install`、`run_commands`），也能 `from_registry` 任意镜像，但镜像里需要有 python/pip，或用 `add_python` 补上。<br>按层缓存，可用 `force_build` 强制重建。构建步骤可以带 `secrets=`，"injected as environment variables during the build"（[Image](https://modal.com/docs/sdk/py/latest/Image)）。<br>基础镜像升级用工作区级 **Image Builder Version**：平台每隔几个月发一版，用户自己选时间切换，切换后下次部署会重建，未钉版本的依赖可能因此出问题（[images#image-builder-updates](https://modal.com/docs/guide/images#image-builder-updates)）。 |
| **Vercel Sandbox** | 可以用托管镜像（每晚发版，滚动 tag 自动跟进，可钉 digest），也可以用推送到 VCR 的任意 OCI 镜像（必须是 linux/amd64）。<br>"does not run Docker `ENTRYPOINT` or `CMD`"，`推断` 运行时由平台注入。<br>持久化 sandbox 停止时自动做文件系统快照，快照可以 fork（[images](https://vercel.com/docs/sandbox/concepts/images)、[snapshots](https://vercel.com/docs/sandbox/concepts/snapshots)）。 |

## 横向对比

| 平台 | 定制形式 | 执行时机 | 缓存/复用 | 安装阶段 root | 安装 vs 运行网络 | 基础镜像约束 | 安装阶段密钥 |
|---|---|---|---|---|---|---|---|
| Managed Agents | 声明式包列表（6 种管理器） | agent 启动前 | 同一 environment 的会话共享；失效规则 `[unverified]` | `[unverified]`（能装 apt） | 同一策略；有 packages 时必须对 sandbox 开放注册表 | 固定 Ubuntu 24.04；自带镜像需 self-hosted | vault 占位符；是否作用于安装 `[unverified]` |
| Claude Code web | setup script + SessionStart hook | 首次会话、Claude Code 启动前 | 文件系统快照；脚本或允许主机变化重建；约 7 天过期；超过约 5 分钟不缓存 | 是（root） | 同一访问级别 | 不可替换 | env 尚未设置；network secret 不附加 |
| Codex（Legacy / 新版） | setup + maintenance script / agent 生成 install script 后 Publish | 建缓存时；复用缓存时跑 maintenance | 最多 12 小时；脚本、env、secret 变化失效 / 已发布的文件系统 | `推断` 是 | Legacy：setup 有网、agent 默认断网；新版：同一白名单 | 只能用 universal，可钉 runtime 版本 | Legacy：只给 setup；新版：两阶段占位符替换 |
| Cursor | Dockerfile/image/snapshot + install/start | Build 时（后台） | 当前生效的 Build；周期或配置变化重建；快照 30 天不用删除 | Dockerfile 层为 root；install `[unverified]` | `推断` 同一策略 | Dockerfile 可换 OS；Computer Use 只支持 Debian/Ubuntu | team/env secret 可用；user secret 不可用；有 Build Secret |
| Copilot | Actions job `copilot-setup-steps` | 每次会话 | 无环境快照；actions/cache 或自定义 runner 镜像 | 免密 sudo | 防火墙不管 setup steps | Ubuntu x64/Windows runner | 与运行阶段相同 |
| Jules | setup script | Run and Snapshot | 仓库级快照；失效规则 `[unverified]` | `[unverified]` | 有网；区分 `[unverified]` | 平台 VM | 仓库级 env，按任务启用 |
| Devin | 三级 blueprint | Build 时 | 组织唯一 snapshot；约 24 小时刷新；可 pin | `推断` 免密 sudo | 会话受 security profile 约束；Build `[unverified]` | 平台 VM | 可用，快照前擦除；企业级可设 Build only |
| OpenHands | setup.sh；Enterprise 自定义镜像 | 每次会话 / 镜像构建时 | 无 / 每镜像一个 warm pool | 免密 sudo（openhands 用户） | `[unverified]` | 必须 FROM agent-server，保留 entrypoint | 全部作为 env，不分阶段 |
| E2B | Template SDK / Dockerfile / 快照 | 构建时（含 start 命令） | 层缓存；模板是含进程的快照 | 按层指定 root | 运行可配；构建 `[unverified]` | 可识别发行版的任意镜像 | 运行时出口注入；构建 `[unverified]` |
| Daytona | 镜像 / 声明式 / sandbox 快照 | 构建时 | 声明式缓存 24 小时；snapshot 两周不用转 inactive | 是（文档建议先 root） | 运行按 sandbox 配置；构建 `[unverified]` | 任意镜像，需带 tag | `[unverified]` |
| Cloudflare | Dockerfile + shim | 构建时 | Docker 层缓存 | 是（Docker 默认） | 运行时 `enableInternet` | 任意 amd64 镜像 + 同版本 shim | `[unverified]` |
| AgentBay | 控制台 / 锁定 FROM 的 Dockerfile 模板 | 本地构建 + 激活 | 镜像固定版本 | 要求 `USER root` | 激活时选网络类型 | 不能改 FROM、不能写 CMD、只支持 x86 | 用户本地 |
| Modal / Vercel | Image 链式定义 / OCI 镜像 + 快照 | 构建时 / 运行中快照 | 层缓存 / 自动快照 | 是 | — | Modal 需 python；Vercel 不跑 entrypoint | Modal 构建可用 `secrets=` |

## 对 OMA 的启示

### 证据对照

- **OMA 第一阶段方案（Agent 声明 pip/npm 列表，按 sandbox 安装，hash 记在 binding 上）与 Managed Agents 的 `packages` 最接近。** 差别在缓存范围：Managed Agents 在同一 environment 的会话之间共享缓存，OMA 只在单个 sandbox 内复用。
- **"按配置 hash 判定是否重装"与行业的失效规则一致。** Claude Code 以脚本和允许的主机为键；Codex 以脚本、env、secret 为键；Cursor 和 Devin 在配置或密钥变化时重建。
- **OMA 用户镜像必须 FROM 平台 base，Pi 升级时就会断。** 这与 OpenHands（必须 FROM agent-server）、AgentBay（锁定 FROM 行）是同一类做法，属于结论 6 的第一类。Cloudflare 1.0 的 donor-shim 和 E2B/Vercel 的平台注入属于第二类，这一类不存在这个问题。
- **OMA gateway 的 checkpoint（只含文件系统、冷克隆）在语义上等同于 Claude Code 的环境缓存和 Cursor/Devin 的 Build 快照。** 文档都写明："只保留磁盘，不保留进程"。

### 建议（第一阶段）

以下是建议，不是已有证据。

1. **Schema 直接照抄 Managed Agents 的子集**：`packages: { pip: string[], npm: string[] }`，版本写法沿用包管理器原生语法。
   - OMA 工具以 `user` 运行、没有 sudo，所以不开放 `apt`，在配置层直接拒绝，对应 Managed Agents 的 400 校验。
   - 同时拒绝 `--index-url`、`-e`、URL 或本地路径这类会改变来源的写法。
2. **安装位置沿用现有约定，与平台工具运行时隔离。**
   - 继续用 `pip install --target $PYTHONPATH` 和 `npm --prefix ~/.local/oma-node`，这样 agent 自己补装的包和平台装的包落在同一处。
   - 不覆盖 `/opt/oma-pi-tools` 和镜像预装的包。依据是 Managed Agents 对 Playwright 的提醒：另装版本会破坏平台预装组件。
3. **hash 的输入至少包括**：规范化后的包列表、base 镜像 digest、Pi 版本、安装器版本。这样换镜像或升级 Pi 时会自动重装，对应 Codex/Claude Code 按配置失效、Modal 的 Builder Version 思路。未钉版本的包"install the latest version"，所以要把解析后的实际版本（`pip freeze`、`npm ls`）写进 binding 或事件，因为 Managed Agents 自己也承认 "Environments are not versioned"。
4. **时机与失败语义复用 Skill Install。**
   - 与推理并行；首个工具调用等待安装完成；失败则结束 Turn，错误码为 `packages_install_failed`。
   - 选 fail-closed 有两个理由：Claude Code 的做法是 setup 非零退出会话就起不来；Copilot 的 fail-open 会让 agent 在残缺环境里工作。
   - 要设安装时限：Claude Code 的缓存阈值约 5 分钟，Cursor 默认 90 分钟。
5. **安装阶段的网络与 agent 阶段分开。** Managed Agents 的坑在于，声明 `packages` 就得把注册表和 github.com 对 agent 也打开。OMA 宜让安装流量只走平台指定的镜像源（如阿里云 PyPI/npm mirror），agent 阶段的 egress 不因 packages 而放宽，对应 Codex Legacy 和 Copilot 的分阶段做法。gateway 或 ACS 能否按阶段切换 egress，需要另行确认，`[unverified]`。
6. **第一阶段只支持公共源。** 以后支持私有源时，参照 Codex Legacy 和 Cursor 的 Build Secret：凭证只注入安装进程，不写 `.npmrc` 或 `pip.conf` 落盘（Devin 的坑），或者走出口占位符替换（Claude Code/Codex 的 network secret）。
7. **Child Session 共享 sandbox**：所需的包集合取并集安装；同名包版本冲突时，在配置层报错。
8. **第二阶段再做跨 sandbox 复用。** Loop 每次触发都会新建 Session 和 sandbox，每次都要重装。可以把"base digest + 包集合 hash"作为 key，用 gateway checkpoint 做"已准备好的文件系统"缓存，加 TTL（Claude Code 约 7 天，Codex 12 小时）。更轻的替代方案是共享 wheel/npm 下载缓存。
9. **长期看自定义镜像**：把 Pi 工具运行时从镜像里解耦，做成可注入的静态制品，在 create 时复制或挂载。版本校验借鉴 Cloudflare 的协议版本字节和 OpenHands 的按特性最低版本，用户镜像就不必再 FROM 平台 base。在此之前，至少要记录用户镜像是从哪个 base digest 构建的，并在 Pi 版本校验失败时给出明确报错。

### 已记录的坑（照搬时要避开）

- 快照和缓存只保留磁盘：服务、数据库和 `export` 都不会延续，需要在每次启动时重新执行（Claude Code、Cursor、Codex）。
- setup 与 agent 在不同 shell 里：环境变量要写进 env 配置或 `~/.bashrc`（Codex）。
- 安装脚本要幂等，可能在已有磁盘状态上再跑一次（Cursor）。
- 缓存在工作区内共享：一个人的失效会影响所有人（Codex Business/Enterprise）。
- 网络按主机放行，不按操作放行：放开注册表，也就放开了向注册表发布包（Managed Agents）。
- `*_latest` 系统镜像会自动更新，生产环境要钉版本或 digest（AgentBay、Vercel）。
