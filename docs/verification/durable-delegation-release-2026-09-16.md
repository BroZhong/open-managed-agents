# Durable delegation release — 2026-09-16

Scope: GitHub issues #133–#141. Release branch: `codex/durable-subagents-133-141`.

## Deployment

- Production: [Agentry](https://agentry.welltop.tech) (`agent-platform`, Shanghai, namespace `oma-infra`).
- Server image tag: `dd1d1d7f77a0`.
- Web image tag: `28160f49506a` (metadata and notification refresh fixes).
- Web image ID: `sha256:6dd42ea25c9cba2c649ade21de2ed9b651eaccff3433b2217e474aa5fe6f50b9`; browser asset `index-Bx6Tzefl.js`.
- Server image ID: `sha256:aa6a85d45ba4648cc36f65f74e9837c458756e115554e4c51f18e052b10022bd`.
- Migration `0011_durable_delegations.sql` applied to the verified production database; application role read access to all six new tables verified.
- Initial cutover: confirmed zero pending inputs and no running Sessions, removed old Host from Service routing, scaled it to zero and waited for termination, then enabled the new Host. No old plugin Turn crossed the cutover.
- Image seed contains only `pi-web-access@0.13.0` and `pi-mcp-adapter@2.11.0`; Host owns the three delegation tools.
- Final image deployed using the image-only release script. The production layout mounts gateway configuration directly; the script also updates `seed-pi-auth` when an installation has that init container.
- Host replacement for recovery verification: `oma-server-57778c8565-ct428` → `oma-server-6dd8696597-lv6n4`, after confirming zero pending inputs. Sandbox resources were retained.

## Automated validation

- Server: all workspace typechecks; 828 tests passed.
- Adapter: 379 tests passed, including the pinned SDK continuation/retry path and controlled stream/argument/budget failures.
- Web: full suite 242 tests passed with two workers after the notification-refresh fix; typecheck, focused lint and production build passed.
- Real PostgreSQL 16: 32 tests passed, including concurrent acceptance, quota, stale fencing, terminal/outbox rollback, interruption, and termination reconciliation.
- Deployment checks: six passed, one existing optional package-download check skipped. OpenAPI generation/validation passed with existing informational warnings.
- Final bounded Standards and earlier Spec reviews: no unresolved blocker.

## Live Pi + Sandbox verification

Model: `openai-codex/gpt-5.6-sol`. Dedicated verification Agent: `agent_BIIIGe_EPrORy93cOgr5p`.

Final results are recorded in [the evidence summary](durable-delegation-release-2026-09-16.json). Each test uses actual API requests, canonical events, Sandbox tools and file reads. API keys are created temporarily and revoked in `finally`; evidence excludes credentials.

All final phases passed, including the final Web release on a fresh background resume. The mounted card associated its execution and updated from running to completed/processed without a reload. The real parent callback replied `Acknowledged.`; browser error collection was empty.

Verification Sessions were terminated after inspection; Agent, Workspace files and canonical histories remain reviewable. The final database check found zero pending inputs and zero active verification API keys. Initial-run Sandbox resources and the local PostgreSQL test container were also stopped/removed.

## Coverage by issue

| Issue | Implementation and verification |
| --- | --- |
| #133 | Durable child Session/execution records; real synchronous delegation, shared Workspace and `/tmp`; atomic acceptance/quota/fencing tested against PostgreSQL. |
| #134 | Background parent completed first; one durable result, one claim and one new completed parent Turn with real model acknowledgement. |
| #135 | Same child ID across multiple executions and a replaced Host; original origin/history and saved files verified. |
| #136 | Original-Turn wait checkpoints, no completed tool replay, queued user input retention and terminal-marker crash windows covered by Router/SDK regression tests. |
| #137 | Live steer changed accepted → applied at a model boundary, with the new token verified in the saved file and child trace. |
| #138 | Live interrupt produced an interrupted child outcome and parent notification; synchronous cascade and independent asynchronous wait interruption covered by Router tests. |
| #139 | Production child detail, creation/call origins, execution-scoped tool I/O and self/delegated/total usage verified via API and browser. |
| #140 | Old plugin removed from installation/default settings; actual drained cutover, fresh image startup, real Pi/Sandbox acceptance and controlled failure regressions completed. |
| #141 | Independent expanded card/trace observation, paging/reconnect tests, historical execution separation and automatic status/notification refresh checked. |

## Findings fixed during verification

1. A consumed synchronous wait must not restart a parent that already has a durable idle, error or aborted marker. Recovery now only completes/acknowledges that Turn; four crash-boundary regressions cover this.
2. Session termination deletes pending input and revokes the execution lease. A periodic, transactional reconciliation now records terminated child results and outbox entries, cancels parent waits, and interrupts only synchronous children of terminated parents. Independent asynchronous children continue.
3. A Skill-free Sandbox has no `/skills` directory and its ordinary user cannot create one under `/`. Preparation now probes read-only and accepts only confirmed `ENOENT`; permissions and transport errors remain failures.
4. Child Session status in the sidebar is refreshed when the separately observed execution status changes. The card and expanded trace continue observing pending/processing notifications after the child is terminal, until delivery reaches a stable state. A tool result also triggers a fresh metadata lookup so a pre-acceptance empty response cannot leave a new card without its persisted execution.

The initial run on `0d064cb9db8d` caught the missing `/skills` failure in a later parent Turn. Its asynchronous child completed, but the callback and steer parent Turns failed. Those results were not counted as successful end-to-end verification; the final image is tested using fresh Sessions and requires real model execution and acknowledgement in the notification Turn.

## Reproduce

Use `deploy/scripts/verify-durable-delegations.mjs` inside the Server image, with the authorized test tenant in `OMA_LIVE_TENANT`. It uses existing PG configuration and `API_BASE_PATH`. Start in `/app/server/packages/api` and invoke with `pnpm exec tsx`.

Sequence: `init`, `sync`, `shared`; copy the evidence JSON out, replace the Host, restore the evidence, then `resume`, `async-start`, `async-finish`, `steer-start`, `steer-finish`, `interrupt-start`, `interrupt-finish`, `budget`, `query`, `ui`, `inspect`, `cleanup`.

`cleanup` requires a successful inspect and no active or pending work. It terminates verification Sessions while retaining the Agent, Workspace files, histories and evidence. Controlled provider stream faults are covered in automated tests; the production run uses the real provider and explicitly checks budget and interrupt outcomes.
