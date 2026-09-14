# Open Managed Agents

Open Managed Agents coordinates long-running AI coding agents across sessions and turns while preserving their working state.

## Language

**Agent**:
A configured AI coding worker that can be used to create **Sessions**. An Agent has one runtime and may be configured to run as a **Sandboxed Agent**.
_Avoid_: bot, assistant, worker

**Sandboxed Agent**:
An **Agent** whose tools run in an isolated Sandbox. In Sandbox-as-Tool mode Pi runs in the Host and uses a per-Turn injected ToolExecutor; Workspace operations execute inside the Sandbox.
_Avoid_: sandbox agent, isolated agent, Kubernetes agent

**Session**:
A conversation and work history for a single **Agent**. A Session contains one or more **Turns** and keeps the Agent's working state between turns when the Agent is sandboxed. An Agent owns many Sessions; a Session belongs to exactly one Agent. The console is entered through an Agent, and its Sessions are listed within it.
_Avoid_: chat, thread, run

**Turn**:
One user message and the Agent execution that responds to it within a **Session**.
_Avoid_: request, job, invocation

**Interrupt**:
A user's demand that the **Session**'s currently running **Turn** stop now. An Interrupt targets that one Turn only: input the user has already queued still runs afterwards, and the Session stays usable. It is a request about the present, not an edit of the past — whatever the Agent had already produced remains part of the Session's history.
_Avoid_: cancel, stop the session, kill (an Interrupt ends a Turn, not a Session)

**Queued Input**:
Input a user has sent that the Host has accepted but is not yet executing. It is durable server state, not a client's optimistic guess: it survives a reload, and it outlives the **Turn** that was running when it arrived — which is why an **Interrupt** ends one Turn while the Queued Input behind it still runs. Input stops being queued the moment a Turn claims it, because claiming promotes it into the Session's history as a user message; so a given input is either queued or executing, never both.
_Avoid_: pending message, optimistic message, draft, backlog

**Interrupted Turn**:
A **Turn** that ended because of an **Interrupt** rather than by the Agent finishing. Its output is kept and shown as it was left — recognizably cut short rather than presented as a finished answer — because a user who stopped an Agent still wants to see how far it got. What the Agent half-produced is history, but it is not treated as work the Agent stands behind: a later Turn continues from the last point the Agent actually completed.
_Avoid_: failed Turn, cancelled Turn, error (an Interrupt is the user's intent, not a fault)

**Delta**:
A transient increment of an Agent's output emitted while the current **Turn** is running. Deltas form a live projection of that Turn only: they are never part of a Session's durable history, are replaced by the corresponding complete event as it arrives, and are discarded if the Turn ends without one.
_Avoid_: event, message, token (a Delta may contain text beyond one token)

**Complete Event**:
A durable, sequenced record of a finalized Agent output block within a **Turn**. A Complete Event replaces the Deltas aligned to the same Turn and output block.
_Avoid_: Delta, chunk, final message (thinking and tool use may also be Complete Events)

**Agent File**:
A named markdown document that shapes an **Agent**'s identity or instructions (e.g. SOUL, IDENTITY, MEMORY, USER). Agent Files belong to one Agent and are isolated per Agent — one Agent can never read another's Files. They are Agent-scoped, not Session-scoped: every Session of an Agent sees the same Files. The Host assembles them into the instructions given to the runtime; the runtime never reads them from a Session's Workspace.
_Avoid_: prompt file, persona file, SOUL (as a category name)

**Skill**:
A self-contained, reusable capability packaged as a directory containing a `SKILL.md`. Every Skill has an **owner**: a **Library Skill** is owned by the tenant and lives in the **Skill Library**; an **Agent Skill** is owned by one Agent and exists only as that Agent's private copy (a **Skill Fork**). When a Session runs, the Host materializes that Agent's equipped Agent Skills into a resource location the runtime loads natively; a Skill is not a Session artifact and does not live in a Workspace.
_Avoid_: plugin, tool (a Skill may bundle tools, but is not itself a tool)

**Skill Library**:
The tenant-scoped collection of all **Library Skills** a tenant has, independent of any **Agent**. Skills are added to the Library once (by uploading a folder — one folder is one Skill if it holds a `SKILL.md`, or many Skills if its subfolders each hold one), previewed and edited there, and then equipped onto Agents as desired. The Library is managed from the same entry page that lists Agents; equipping happens on an individual Agent's page. A Library Skill can be equipped by many Agents; each equip produces an independent **Skill Fork**.
_Avoid_: marketplace, catalog, registry

**Equip** (a Skill onto an Agent):
To fork a **Library Skill** onto an **Agent**: the Host snapshots the Library Skill's files into a new **Agent Skill** (a **Skill Fork**) that the Agent's Sessions load. Equipping copies the Skill at that moment; later Library edits do not propagate to the fork. Unequipping removes the Agent's fork, not the Library Skill.
_Avoid_: install, add, attach, link (equip is a copy, not a reference)

**Skill Fork**:
The Agent-owned copy produced when a **Library Skill** is equipped onto an **Agent**. The fork has its own id and records the `source_skill_id` it was forked from. From then on the two are independent: editing the Library Skill never changes the fork, and editing the fork on the Agent's page never changes the Library Skill. This is why an Agent can preview and edit its equipped Skills freely, and why deleting a Library Skill leaves already-equipped Agents unaffected.
_Avoid_: link, alias, reference (a fork is a copy, not a pointer)

**User**:
A human who signs in to the web console with a username and password. Registration requires a valid invite code. Each User is paired one-to-one with a **Tenant** created at registration time; a User has exactly one Tenant and a Tenant has exactly one User. A User's login produces a session token that resolves to that same **Tenant**, so everything the User sees (Agents, Sessions, Skills, API keys) is scoped to their Tenant.
_Avoid_: account, member, person

**Tenant**:
The isolation boundary that owns everything in the system — **Agents**, **Sessions**, **Skills**, **API keys**. Historically a Tenant was an implicit identifier with no record of its own. It is now created together with a **User** at registration (one-to-one). A request reaches a Tenant through one of two credentials that both resolve to the same `tenantId`: an **API key** (`x-api-key`, for machines) or a **User**'s session token (`Authorization: Bearer`, for humans). API keys a User creates while signed in belong to that User's Tenant.
_Avoid_: org, organization, workspace, account

**Workspace**:
The Tenant-owned persistent file tree in OSS that a **Session** binds immutably at creation. Many Sessions may share one Workspace concurrently and may overwrite the same file. Its only persistent Sandbox path is `/home/user/workspace`; HOME `/home/user`, dependencies and caches remain local. A successful write followed by successful close saves that file independently of Turn success. Interrupt and Session deletion retain already saved files. There is no Turn transaction, rollback, automatic history migration, versioning or undo.
_Avoid_: Tenant, home directory, snapshot, Turn output transaction

## Sandbox provisioning

**Sandbox Manager**:
The single owner of a sandbox's lifecycle — create, reclaim, rebuild, list, describe — shared by both the Sandbox-as-Tool mode and the future Agent-in-the-Sandbox mode. It reads an **Environment Spec** to know what to build and verifies its mounted Workspace before execution, refreshes Read-only Projections, and releases execution resources. It knows no Agent runtime or business ownership policy; the Host supplies trusted storage coordinates.
_Avoid_: sandbox pool, orchestrator, lifecycle pool, executor

**Environment Spec**:
The recipe the Host computes for one sandbox and hands to the **Sandbox Manager**: which image, which env, the bound **Workspace**, and any **Read-only Projections**. It is a value, not a behaviour — no I/O, no lifecycle. It is the sole contract between the Host (which owns the domain knowledge of what an environment needs) and the Manager (which owns the mechanism of building it).
_Avoid_: config, sandbox config, environment, EnvVars

**Workspace Store**:
The home of a **Workspace**'s persistent files. The Host accesses it through `ArtifactStore`; `OSSArtifactStore` implements the file API and exact-prefix mount-probe readback. The Sandbox mounts the same OSS prefix directly through CSI and restricted Agent Identity credentials. Storage does not hydrate, scan, hash or synchronize a local copy at Turn boundaries. `WorkspaceMetadataStore` separately stores the Workspace record and name.
_Avoid_: sync engine, baseline, checkpoint publisher

**Read-only Projection**:
External content projected into a Sandbox path outside the Workspace, never written back. Equipped Skills use `/skills/<skill-name>`; ownership and Supabase source coordinates still use Skill ID internally. Names must be safe single directory components and unique among the Agent's equipped Skills. A Skill rename removes its old projection before loading the replacement. Projection targets cannot contain, equal, or sit inside the Workspace mount.
_Avoid_: mount, read-only mount, static files, assets

**Provision Source**:
Where a **Read-only Projection**'s content comes from, sealed behind one interface so the projection mechanism is indifferent to it. Supabase is the current Skill source; `S3ProvisionSource` retains its existing name and uses `S3SkillArtifactStore`. Workspace OSS configuration and credentials are independent of Skills.
_Avoid_: loader, fetcher, downloader

## Example Dialogue

Developer: "Should this Agent run directly in the API service?"

Domain expert: "No. For the online alpha, make it a Sandboxed Agent so its tools use a verified Sandbox and the Session shares its persistent Workspace across rebuilds."
