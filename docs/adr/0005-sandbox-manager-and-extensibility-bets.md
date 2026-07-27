# ADR-0005: Sandbox Manager, and where the extensibility bets are placed

## Status

Accepted. Extends ADR-0002 (Sandbox-as-Tool for Pi) — it names the lifecycle owner ADR-0002 left implicit and pins down which seams are real versus hypothetical.

## Context

ADR-0002 established the `ToolExecutor` seam and put hydrate/sync/lifecycle inside a single `SandboxToolExecutor`. As we prepared to (a) align the Pi tools to Pi's native schema by redirecting its filesystem into the sandbox, and (b) let a future Agent-in-the-Sandbox mode reuse sandbox management, three questions surfaced that this ADR settles:

1. What is genuinely *shared* between Sandbox-as-Tool and Agent-in-the-Sandbox?
2. Where does the extensibility budget get spent — and where is it deliberately *not* spent?
3. Do equipped Skills live on the Host or in the sandbox?

## Decision

### 1. The shared foundation is the Sandbox Manager — not the primitive layer

Agent-in-the-Sandbox runs the adapter *inside* the sandbox using local `fs`; it has **no file mapping**. Sandbox-as-Tool runs the adapter on the Host and maps tool calls *into* the sandbox, which is the *only* mode that needs cross-process fs/exec primitives. Therefore the fs/exec primitive layer is **Tool-mode-only** and does not sink into a shared base.

What both modes genuinely share is **sandbox lifecycle**: create / reclaim / rebuild / list / describe, plus hydrate and sync at the lifecycle edges. This is named the **Sandbox Manager**. `SandboxToolExecutor` is split: lifecycle rises into the Manager; the executor keeps only the Tool-mode primitives over a ready sandbox handle.

### 2. The extensibility bet is spent on the storage medium — and nowhere else

Three layers, three deliberately asymmetric extensibility stances:

- **Workspace Store (medium): keep a deep, medium-agnostic seam.** S3 is today's only implementation, but the medium *will* change (persistent volume, image snapshot, in-sandbox sidecar). This is a real future, so the seam is built now.
- **Sandbox Manager (lifecycle): shared across both modes.** Both Tool and Agent modes provision and reclaim sandboxes.
- **fs/exec primitives + Pi tools: hard-wired to Pi, zero reservation.** A "second, non-Pi tool consumer" is hypothetical. Per "one consumer is a hypothetical seam, two is a real one," we do **not** extract a reusable/neutral tool package. Tool-mode code may couple freely to Pi.

The Pi tools themselves use Pi's own `create*ToolDefinition(cwd, {operations})` factories, so the schema is guaranteed identical to Pi's native tools — we implement only the `*Operations` that redirect fs/exec into the sandbox.

### 3. Two orthogonal kinds of sandbox content

- **Workspace** — writable `/home/user` content with an Agent-scoped persistence mode. `durable` is the default: hydrate from and sync back to the **Workspace Store** (content-hash push + baseline-diff delete), with a per-sandbox **Baseline** private to the Store. `ephemeral` deliberately performs neither operation while retaining the same live sandbox between Turns; it is reserved for Agents whose authoritative state is external to OMA.
- **Read-only Projection** — one-way, downward only, **never synced**. Equipped Skills, a code repo, a dataset. Projected into a path *outside* `/home/user` (e.g. `/skills`, `/repo`) so the sync scan never mistakes it for a user artifact. Its source is a pluggable **Provision Source** (S3 today; git/tarball later). Content flows S3 → sandbox directly, never routed through the Host — the Host supplies only coordinates.

### 4. Skills must be projected into the sandbox

Because the Pi adapter runs with `noTools: "builtin"` and custom tools, Pi's prompt tells the model to *load a Skill's file with the `read` tool* rather than inlining Skill bodies. That `read` tool is mapped into the sandbox. So a Skill left on the Host is unreadable — Skills **must** be projected into the sandbox as a Read-only Projection. (This is opposite to FastClaw, whose read tool is not sandbox-mapped, so it keeps Skills on the Host.)

(Since #80 the custom tools use Pi's own `create*ToolDefinition` factories, so the read tool is named `read` — identical to Pi's native tool — not the earlier hand-written `read_file`.)

### 5. Sync is a Workspace concern, triggered at a lifecycle checkpoint

Sync belongs to a durable Workspace, not to a Session/turn. It is triggered at sandbox lifecycle checkpoints (a turn-end checkpoint is retained as a convenient, cheap safe point; the Manager also syncs before dispose/rebuild). Upload to S3 is already incremental (content hash); detection becomes incremental via a size+mtime pre-filter before hashing. The `workspace.file_change` event is an idempotent "refresh now" pulse emitted only to the triggering Session's stream — no cross-instance registry, since S3 is authoritative and the frontend already backstops on turn end.

The Environment Spec carries the Agent's persistence mode. `durable` (including an omitted mode) preserves the lifecycle above. `ephemeral` makes hydrate, refresh-from-medium, checkpoint sync, and dispose sync empty operations; sandbox creation, reuse, reclaim handling, tool isolation, and Read-only Projection refresh remain unchanged.

The Environment Spec may also receive a **Runtime Sandbox Credential** from the authenticated event ingress. This is a narrow escape hatch for per-user external API authorization: `X-VFS-Token` maps only to `VFS_TOKEN`, overrides deployment/Agent defaults for the new Session sandbox, and is never copied into the queued event, event log, Agent record, prompt, or Workspace. The browser repeats the header on every user message so another Host can create the sandbox after load balancing. A Host crash between accepting the durable event and creating the sandbox can lose this transient value; recovery then fails closed at the external CLI and the client must retry rather than persisting a reusable user credential.

## Consequences

- A crash-orphaned sandbox is bounded by the existing ~1h TTL; the Manager interface reserves `list`/`reclaim` for a future active sweep, but no sweep is built now (no evidence of orphan-cost pain yet).
- A sandbox reclaimed by the gateway between hydrate and sync loses that turn's un-synced files — a known eventual-consistency cost of S3-authoritative, disposable sandboxes (consistent with ADR-0002's "1:N collisions are the user's responsibility").
- An Agent choosing `ephemeral` declares `/home/user` non-authoritative: a reclaim or Host restart loses it by design. External CLI/API state must be the source of truth, and no `workspace.file_change` event is emitted for those local files.
- Future architecture reviews should **not** re-suggest extracting a neutral/reusable tool package: that seam is intentionally hypothetical (§2). Revisit only when a real second non-Pi consumer exists.
