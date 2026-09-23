# API / Runner split verification

Local verification for #197–#203, September 24, 2026. No production switch,
external model call, real Sandbox deletion, or model-release automation was run.

The opt-in `server/packages/api/test/split-process.test.ts` suite uses real
PostgreSQL 16 and Redis 7 on loopback, separate Node OS processes and random PG
schemas. It tests HTTP/SSE and the existing public coordination interfaces:

- Two API processes subscribe while competing Runner processes execute one input;
  both receive Deltas and Complete Events; reconnect emits no duplicate history.
- Input accepted with no Runner is visibly queued and runs after Runner startup.
- Killing API leaves Runner output progressing; acceptance without a Redis wake is
  recovered by scanning.
- Interrupt from another API preserves the next queued input and ends only its
  targeted Turn; Session termination fences input without API execution objects.
- Loop dispatch continues while both APIs are stopped; manual dispatch preserves
  cadence.
- Redis unavailable at Runner startup and lost mid-Turn: open SSE clients receive
  complete output and idle status from PG; reconnect restores live Deltas.
- Synchronous and asynchronous delegation run parent and child in different PIDs,
  retaining the parent model, 500-step budget and result consumption rules.
- Two cleanup Runners handle a failed gateway deletion, retry idempotently from
  durable binding state, and retain unknown activity until exact settlement.

The API catch-up regression first failed with only the SSE retry frame after PG
commit, then passed with periodic incremental catch-up. Existing replay, projection,
share/auth, queue-fence, delegation and controlled Sandbox tests remain applicable.
The web termination regression first reported idle, then exercises the new durable
termination lifecycle projection.

Real model output and real gateway deletion are intentionally outside the local
fixture coverage. The independently versioned deployment manifest and executable
cutover plan are prepared in `deploy/k8s.split.yaml` and
`docs/api-runner-operations.md`. Production image-pair and mounted Workspace
verification must accompany the separately authorized deployment; this report
makes no claim of production or arbitrary historical-image compatibility.
