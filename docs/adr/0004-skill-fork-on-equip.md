# ADR-0004: Equipping a Skill forks it into an Agent-owned copy

## Status

Accepted. Changes the equip semantics established in the CONTEXT glossary and the reference-based model in ADR-0002-era code (`Agent.skills = skillId[]` pointing at Library Skills).

## Context

Skills were equipped **by reference**: `Agent.skills` held Library Skill ids, and the Host materialized those Library Skills at turn start. This had two consequences the product does not want:

1. There is no way to preview/edit an equipped Skill on the Agent's page without editing the tenant's Library Skill — one Agent's tweak would change the Skill for every Agent that equips it, and for the Library itself.
2. Deleting a Library Skill leaves a **dangling reference** in `Agent.skills`. Materialization silently skips the missing id (validated by tenant ownership), so the Agent believes a Skill is equipped while runtime behavior ignores it. The 2026-07-06 E2E report observed exactly this: an Agent referencing `skill_JWy7c…` that no longer had a row in `skills`.

## Decision

Equipping a Library Skill onto an Agent **forks** it: the Host snapshots the Library Skill's files into a new **Agent Skill** (its own `skill_id`, `owner_type=agent`, `owner_id=<agentId>`, `source_skill_id=<libraryId>`). `Agent.skills` holds Agent Skill ids, not Library Skill ids.

- Library and fork are independent after equip. Editing the Library Skill does not propagate; editing the fork on the Agent page does not touch the Library.
- The Agent page previews and edits the fork; the Library page previews and edits the Library Skill.
- Ownership is carried by an `owner_type`/`owner_id` column on the existing `skills` table (single table, filtered by owner), not a separate table.

## Considered Options

- **Copy-on-write** (equip stores a reference, materializes a private copy only on first edit): keeps un-edited forks in sync with Library updates, but adds a "has this been forked yet?" state to every read and materialization path. Rejected as more complex than the product needs.
- **Reference + read-only Agent view** (keep by-reference, forbid editing on the Agent page): sidesteps forking entirely but contradicts the requirement that Agent-page edits be possible without affecting the Library.

## Consequences

- Deleting a Library Skill no longer affects already-equipped Agents — the dangling-reference class of bug is structurally gone.
- Library edits after equip do **not** reach Agents; re-equipping is the way to pull in Library changes. This is a deliberate trade of "stay in sync" for "edit safely in isolation."
- Storage grows with equips (one copy per Agent per Skill) rather than one shared Library copy.
