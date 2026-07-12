# ADR-0002: Pi Agent via Sandbox-as-Tool with S3-authoritative Workspaces

## Status

Accepted. Extends (does not supersede) ADR-0001 — realizes its "Sandbox as Tool mode for Pi Agent (future)" while Agent-in-the-Sandbox remains for Claude Code and Codex.

## Context

We need Pi to run as a resident multi-user service that builds context from persisted events, streams live deltas to a frontend, and gives tool calls a real filesystem whose artifacts are visible in the UI. ADR-0001 established Agent-in-the-Sandbox (the whole adapter runs inside a per-session sandbox, server manages lifecycle). It also foresaw a Sandbox-as-Tool mode for Pi. This ADR pins down that mode and the persistence/storage shape around it.

## Decision

### 1. Adapter stays a stateless translator; the Host owns infrastructure

The Adapter contract is unchanged: `run(input): AsyncIterable<SessionEvent>`. It translates between events and the Pi SDK session and touches no infrastructure. "Resident" and "coupled to infrastructure" are orthogonal — the Adapter may run inside a resident Host process while remaining a pure per-call translator. Everything infrastructural (context-building, persistence, messaging, sandbox lifecycle, artifact storage) lives in the Host, which is the existing Server.

### 2. Sandbox-as-Tool for Pi

Pi runs in the Host. Its tool calls are intercepted via Pi's Extension/`host_tools` mechanism and proxied into a Sandbox. Because interception must happen at the Pi SDK layer, the Adapter is the only place it can live — so the Adapter accepts a **`ToolExecutor` injected as a per-`run()`-call parameter** (not constructor state, never shared mutable state). The Adapter knows only an abstract executor that can run commands and read/write files; it does not know it is a sandbox. The Host implements and injects a `ToolExecutor` already bound to the correct Workspace. Per-call injection (vs. FastClaw's shared mutable registry) is what makes true per-agent concurrency safe.

### 3. Persistence: PostgreSQL authoritative, Redis transient, S3 for artifacts

- **PostgreSQL** holds the authoritative event log and full messages (control plane too). MongoDB is retired.
- **Redis** carries transient traffic only: the pending-input queue and per-turn delta streams (`stream:turn:{turnId}`, reclaimed when the turn ends). Deltas are never persisted to PostgreSQL; a turn's final content is stored whole as an Event, aligned to deltas by `turnId` + `blockIndex`.
- **Reconnect merge is server-side**: the Host replays completed Events from PostgreSQL, then appends the active turn's Redis deltas, presenting the frontend a single SSE stream. Active-turn state (`sessionId → turnId + status`) lives in Redis/PostgreSQL, not process memory, to keep multi-instance reconnect correct.
- **Frontend replacement is block-aligned**: it retains every incomplete Delta block in the current Turn until the Complete Event with the same `turnId + blockIndex` arrives (or the Turn ends). A later block never erases an earlier incomplete block, and the Delta/Complete projections share one logical UI identity so finalization does not remount the bubble.

### 4. Workspaces are S3-authoritative; sandboxes are disposable

- A **Workspace** is the S3-backed authoritative home of a Session's artifacts. There is one kind; a user-supplied ID is used as-is, an unspecified one is auto-created. A Session binds one Workspace immutably at creation; a Workspace may be bound by many Sessions concurrently (collisions are the user's responsibility). Workspaces belong to a tenant.
- **Sandboxes** (Alibaba Cloud ACK Agent Sandbox via the e2b SDK) are short-lived and stateless: created lazily on first filesystem/code tool use, hydrated from S3, synced back, destroyed. No pause/resume — that model is 1:1 per-instance and conflicts with 1:N Workspace sharing and S3-authoritative storage.
- **Sync** (owned by the `ToolExecutor` implementation, invisible to the Adapter): full `/home/user` scan (the canonical Workspace root; catches shell-created files), content-hash to push changes, and a hydrate-baseline diff to propagate deletions — deleting from S3 only files present in this sandbox's hydrate baseline but now absent, so concurrent sessions never delete each other's new files. The baseline lives in Host memory for the sandbox's lifetime.

### 5. Artifacts surface through the Host

The frontend lists files by having the Host `ListObjects` the Workspace's S3 prefix (S3 is the source of truth, so shell-created files appear). File contents are served by Host proxy, not presigned URLs. On sync completion the Host emits a file-change event on the SSE stream for live tree updates; the frontend also refetches on turn end.

## Consequences

- Pi diverges from Claude Code/Codex, which keep Agent-in-the-Sandbox. Unifying all runtimes on Sandbox-as-Tool is explicitly out of scope here.
- The `ToolExecutor` abstraction is the single seam between the pure Adapter and all infrastructure; getting its per-call injection right is what preserves both the "no infrastructure in the Adapter" rule and multi-user concurrency.
- Deletions in a sandbox propagate to S3, but only within a session's own baseline — deletes made by a concurrent session are not seen until the next hydrate (eventual consistency, by design).
- Retiring MongoDB and introducing Redis is a real migration of the existing Server store layer.
