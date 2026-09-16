# Session usage and process timing release — 2026-09-16

Implementation commit: `c11842bb32e7629dd567f95cee7886f5073fce09`.

## Deployment

- Built and pushed Web from a clean checkout on `vfs-dev` using `bash build.sh --push web`.
- Applied through `deploy/scripts/deploy-app.sh`, including its server-side dry-run.
- Target: `agent-platform`, namespace `oma-infra`.
- Web image: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web:c11842bb32e7`.
- Registry manifest digest: `sha256:5e24d795479d3fadd1dc4c4f4051c20f2e6e95273b5fde6e00accc487375637b`.
- Server remains `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server:24a74e3374d8`.
- Both Deployments ready; health returned `{"status":"ok"}`.
- Public HTML references `index-DVMKF3l8.js` and `index-BYOHCDCc.css`.

## Automated validation

- Web: **41 test files, 300 tests passed**.
- TypeScript and production builds passed locally and in the release image.
- ESLint passed for modified application files; `git diff --check` passed.
- Tests cover contiguous process boundaries, wall time for parallel tools, interrupted turns and idle gaps, streamed timestamps, invalid timestamps, ticking while running and stopping when idle.
- Integration tests cover independent parent/child usage, history plus live updates, and deduplication of replayed events.
- Existing non-blocking warning: the main JavaScript chunk exceeds 500 kB.

## Production verification

Authenticated Chrome verification used the supplied Session:
`https://agentry.welltop.tech/sessions/sess_ANzfkrGRExjxk5ysAgqBj`.

1. Conversation has a persistent footer below the composer with total, input, output, cache read/write tokens and KV cache hit rate.
2. Parent totals: **3,268,165** total, **3,244,527** input, **23,638** output, **3,126,784** cache read, **0** cache write, **96.4%** hit rate.
3. Clicking the existing Agent row opens `Agent 1`. Its footer displays **287,905** total, **268,942** input, **18,963** output, **203,648** cache read, **0** cache write, **75.7%** hit rate.
4. Both sets of counts match independent, read-only SQL aggregates of persisted `span.model_request_end` usage: 41 parent requests and 8 child requests. Total is input + output; hit rate is cache read / input. Parent counts exclude child requests.
5. Switching back to Conversation restores the parent values. Screenshots confirmed both footers fit the visible Session panel without overflow.
6. Parent process groups show `59s`, `45s`, `5m 17s`, `1m 49s`, `7m 26s`, `28s`, and `2m 43s` in chronological order. Child groups show their own elapsed times, including `1m 23s`, `1m 32s`, `1s`, `16s`, and `1m 17s`.

No prompts were sent or Workspace files edited during production verification. Live ticking and stream reconnection were exercised by automated tests; the historical production sessions remained idle.
