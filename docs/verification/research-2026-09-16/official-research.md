# Claude Subagents 官方文档定向核验

## 获取记录

【事实】2026-09-16T03:26:15Z（UTC）以 curl 跟随重定向访问 `https://code.claude.com/docs/en/sub-agents.md` 与 `https://code.claude.com/docs/en/agent-sdk/subagents.md`；最终 URL 均未改变，HTTP 均为 200，响应均为 Markdown。原文保存于 `/home/user/workspace/research/docs/claude-code-sub-agents.md` 与 `/home/user/workspace/research/docs/agent-sdk-subagents.md`；抓取字段及摘要见 `/home/user/workspace/research/docs/fetch-metadata.tsv`。

## 三个规则主题

【事实·独立上下文】普通 Claude Code 子代理从新的隔离上下文启动，不继承父会话历史、已调用技能或已读文件，只把最终结果交回；fork 是例外，会继承父会话。SDK 同样以新会话启动，父级显式传入的核心是 Agent 工具提示词。（证据：`/home/user/workspace/research/docs/claude-code-sub-agents.md:1035`、`/home/user/workspace/research/docs/claude-code-sub-agents.md:1127`；`/home/user/workspace/research/docs/agent-sdk-subagents.md:26`、`/home/user/workspace/research/docs/agent-sdk-subagents.md:178-190`）

【事实·并行子任务】Claude Code 后台子代理可与主工作并发，官方建议仅把彼此独立的调查并行化；SDK 也允许多个子代理同时运行。（证据：`/home/user/workspace/research/docs/claude-code-sub-agents.md:870-880`、`/home/user/workspace/research/docs/claude-code-sub-agents.md:946-960`；`/home/user/workspace/research/docs/agent-sdk-subagents.md:24-29`）

【事实·嵌套限制】当前默认允许主代理以下三层子代理；到达深度后不能再派生，可用 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 调整，设为 1 即关闭子代理再派生。交互模式会让派生者等待后台子代理，而 SDK/非交互模式不等待。（证据：`/home/user/workspace/research/docs/claude-code-sub-agents.md:989-1007`；`/home/user/workspace/research/docs/agent-sdk-subagents.md:605-618`）

## 产品与接口区别

【事实】Claude Code 面向终端会话，以带 YAML frontmatter 的 Markdown、作用域目录、自然语言、@ 提及和 `--agent` 管理调用；Agent SDK 推荐在 `query()` 的 `agents` 参数中用 `AgentDefinition` 编程定义，并从消息流识别 Agent 工具调用；恢复时还须保留 session ID 与 agent ID。（证据：`/home/user/workspace/research/docs/claude-code-sub-agents.md:94-149`、`/home/user/workspace/research/docs/claude-code-sub-agents.md:805-820`；`/home/user/workspace/research/docs/agent-sdk-subagents.md:12-35`、`/home/user/workspace/research/docs/agent-sdk-subagents.md:300-308`、`/home/user/workspace/research/docs/agent-sdk-subagents.md:391-405`）【推断】因此前者偏人机交互配置，后者偏应用代码控制生命周期；底层规则相近，但入口与可观测接口不同。

## 并发上限与例外核验

【事实】20 只是当前默认并发值，可由 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 改写，且会话累计派生数不限，不能表述为无例外硬上限。逐词核验发现 `ultracode` 在两份原文均出现：启用时不执行该限制；`/subtask` 仅见于 Claude Code 原文，其 fork 占槽位却不因达到限制而被拦；`resume` 两份均出现，而 Claude Code 明示已结束子代理的恢复会取得新槽位且不先检查限制。（证据：`/home/user/workspace/research/docs/claude-code-sub-agents.md:1018-1029`；`/home/user/workspace/research/docs/agent-sdk-subagents.md:613-621`）【推断】SDK 页自身只足以确认默认值、可配置性及 ultracode 例外；另两项例外须以其链接的 Claude Code 页为依据。
