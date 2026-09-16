# 单层 Subagent 综合评估

1. **适合边界清楚、彼此无依赖的源码探索与资料调研。** 官方文档确认普通 subagent 使用独立的新上下文，多个任务可并行；本次两条路径分别固定源码提交和官方页面，互不依赖。源码侧又证明并发 Session 即使 Turn ID 相同，delta 仍以 `sessionId + turnId` 隔离。因此优先使用两个第一层 agent 分工即可，无需为了“并行”引入嵌套。证据见 [code-exploration.md](/home/user/workspace/reports/code-exploration.md) 与 [official-research.md](/home/user/workspace/reports/official-research.md)。

2. **委派提示应是一份可验收的证据契约。** 独立上下文不会自动继承父会话已读资料，最终通常只回传结果，所以必须显式给出固定 SHA/URL、目标文件、输出路径、篇幅、行号、HTTP 状态与访问时间，并要求保存原文和读回。并发规则也应按原文保留限定：20 是可配置默认值，且有 `ultracode`、`/subtask`、`resume` 例外，不能写成硬上限。

3. **主 agent 必须读产物、抽查证据并负责最终判断。** 本次单测支持 Session 参数级隔离和父 Turn model 固定，但未覆盖真实 Redis/PostgreSQL、多 Host 竞争及 provider 的 `onResolved` 集成；在线文档也可能更新。单层方案便于把失败恢复到原 agent、定位证据来源，并避开交互模式与 SDK 对嵌套后台任务等待行为不同的复杂性，适合作为短工程调研的默认结构。
