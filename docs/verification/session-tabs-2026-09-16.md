# Session tabs and child tool restrictions — 2026-09-16

## Change

Rebased `codex/durable-subagents-133-141` onto `main` at `cf47dc83ada9`, preserving its SplitWorkbench layout and direct Skill checkbox behavior.

Implementation commit: `e4860c5bc43d`.

- Session activity is a spinner for running/waiting Turns; idle and terminated Sessions render no status label.
- Removed the Session header's usage metrics and Live indicator, plus the usage/delegation/origin blocks above the conversation.
- The sidebar requests `exclude_delegated=true`. Memory and PostgreSQL stores apply this before pagination; other clients retain the existing default list behavior.
- Clicking an Agent call opens a peer tab for the complete Child Session. Calls that resume the same child reuse the tab. Each open child has independent history and SSE; closing its tab cancels that subscription. The parent's draft, conversation DOM, scroll and stream remain mounted.
- Child restrictions now follow persistent Session identity, including later direct user input. The Host refuses to issue delegation capabilities to children. The actual Pi SDK registry exposes only `bash`, `edit`, `find`, `grep`, `ls`, `read`, `write`, even when ambient extensions register additional tools for the parent.

## Automated verification

- Server: **832 passed**, 7 optional integration tests skipped in the default suite.
- Adapter: **383 passed**, including four actual SDK tool registry tests.
- Web: **255 passed**, including real HTTP/SSE hook integration for child tabs, resumed Turns, direct child input, deduplication, cleanup and parent draft preservation.
- Separate PostgreSQL Session store suite: **15 passed**, using an isolated local test schema.
- Server/Adapter typechecks and Web TypeScript/build passed.
- Deployment tests: 6 passed, 1 existing package inspection test skipped.
- OpenAPI regenerated and validated; four existing lint warnings remain.
- Code review: no blocking standards findings or unmet requirements after final review.

## Production verification

Server and Web both run `e4860c5bc43d` in `agent-platform/oma-infra`.

- Server image ID: `sha256:7feb6c901034baca2076b3da80f706c2d5adf88104ad6e9a2d79063e2bfcffc9`.
- Web image ID: `sha256:fc3711843d125722e1a43130503f3125e344168713b55f4c11b0347fd5176ddc`.
- Both Deployments are ready. The first external health probe during rollout returned 502; subsequent probes and live checks returned success.
- Historical parent `sess_ecRiywKtaD7-L3sFXUid3`: sidebar expansion showed only the parent; the child tab displayed the initial task and both resumed Turns, without usage or delegation lists. Returning to the parent preserved its unsent draft.
- New parent `sess_VOng-dbHPIEP8LRLzdyPd`, child `sess_bb-RhGsywsUSPMuTqbs2d`, execution `deleg_nLkeOhq8oQHvD8HVQ1b03`: a real Pi/Sandbox child executed `sleep 45`, then returned `SESSION_TAB_VERIFIED`. Browser inspection and screenshot showed running spinners in both the parent and child; completed Sessions displayed neither spinners nor status labels.
- Child history then displayed a later direct user input and its model response. No nested execution or delegation tool call was created. Tool availability is verified by the SDK registry tests above, not inferred solely from model self-report.
- Reopening the Agent call kept exactly one child tab. Closing it returned to the original parent draft. No browser route change was needed.
- Live API assertions confirmed that the default list includes the child and the sidebar filter returns its parent while excluding all delegated Sessions.
- The two new verification Sessions were terminated after becoming idle with no queued input; their history remains inspectable. Temporary verification API keys were revoked, and the local PostgreSQL test container was stopped.

Machine-readable live assertions are in [session-tabs-2026-09-16.json](session-tabs-2026-09-16.json).
