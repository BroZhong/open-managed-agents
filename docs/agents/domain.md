# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

ADR-0001 records a historical deployment proposal, not a supported release
path. Current Sandbox templates live under root `sandbox/`; shared deployment
infrastructure lives under `deploy/`.

For Pi SDK integration and Sandbox tool execution, ADR-0014 is authoritative;
ADR-0013 retains the message fidelity and automatic compaction requirements.
ADR-0015 externalizes large tool results to OSS and defines lazy event-data reads.
ADR-0016 makes new Pi native entries authoritative and derives display events without duplicate durable content.
For Turn persistence, ADR-0020 is authoritative: one TurnJournal per Turn attempt
is the only write entry, and every native message is committed before Pi proceeds.
For Host-managed MCP work, ADR-0006 is authoritative. For recurring Loop
dispatch and its Session ownership semantics, ADR-0007 is authoritative.
For Sandbox lifecycle, ADR-0019 is authoritative and supersedes ADR-0017: finite
native pause/retention, per-Turn preparation, event-driven idle and direct release.
For Skill storage and installation, ADR-0022 is authoritative: versioned Skill
Bundles in OSS installed by Skill Set version. It supersedes ADR-0005 §3–4 and
ADR-0008's Skills paragraph, and revises ADR-0004's fork copy and ADR-0019's
per-Turn Skills refresh.
For Sandbox binding creation and recovery, ADR-0023 is authoritative: the gateway
is the truth, a creation intent has a deadline and is reconciled by
`oma.dev/binding`, termination reclaims by binding and every Runner sweeps. It
supersedes ADR-0019's operator-only reconciliation and revises its budgets.
For mounted Workspace storage and Sandbox paths, ADR-0008 supersedes the
former storage portions of ADR-0002 and ADR-0005. ADR-0009 defines the direct
Workspace file API and supersedes ADR-0008’s per-Session write gate.
ADR-0012 changes file reads to signed OSS URL descriptors and permits a configured
public HTTPS preview domain.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
