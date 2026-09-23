# Open Managed Agents

Open Managed Agents coordinates long-running AI coding agents across sessions and turns while preserving their working state.

## Production deployment

Production runs on the Shanghai (`cn-shanghai`) **agent-platform** cluster.
Use `kubectl --kubeconfig "$HOME/.kube/agent-platform-config"` explicitly;
the machine's default context may point to another cluster. The Host and web
console are in `oma-infra`; SandboxSets are in `sandbox-system`.

The Host enables sandboxes with global default template
`auto-story-v2` (the sole maintained Sandbox template) and E2B domain `sandbox.agentry.welltop.tech`.
Sandbox images come from the Shanghai ACR repository
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox`.
See `deploy/k8s.yaml` and `sandbox/README.md` for deployment configuration.
Historical test reports describe their original runs, not the current deployment.

## Repository boundaries

`sandbox/` contains the sole maintained template, its image recipe and required
build tools. `deploy/` contains application deployment and shared infrastructure.
Business Agent presets, prompts, workflows and Skill content belong outside
this repository; the platform still provides Skill Library, Equip and projection
mechanisms. The legacy `AUTO_STORY_*` environment injection remains required by
existing production Agents and must be migrated before removal.

## Language

**Agent**:
A configured AI coding worker that can be used to create **Sessions**. An Agent has one runtime and may be configured to run as a **Sandboxed Agent**.
_Avoid_: bot, assistant, worker

**Agent Fork**:
A new **Agent** copied from an existing Agent's configuration, **Agent Files**, and current **Agent Skills**. Every copied Skill has a new ID and belongs to the new Agent, with its original Library provenance retained. Forking preserves private edits, even when a Library source was deleted. Sessions, Loops and Workspaces are not copied. Subsequent edits to either Agent's configuration or files are independent.
_Avoid_: shared Agent, linked copy

**Sandboxed Agent**:
An **Agent** whose tools run in an isolated Sandbox. In Sandbox-as-Tool mode Pi runs in the Host and uses a per-Turn injected ToolExecutor; Workspace operations execute inside the Sandbox.
_Avoid_: sandbox agent, isolated agent, Kubernetes agent

**Session**:
A conversation and work history for a single **Agent**. A Session contains one or more **Turns** and keeps the Agent's working state between turns when the Agent is sandboxed. An Agent owns many Sessions; a Session belongs to exactly one Agent. A Session may also be created by one **Loop**, in which case it is listed under that Loop and still belongs to the Loop's Agent. The console is entered through an Agent, and its Sessions are listed within it.
_Avoid_: chat, thread, run

**Child Session**:
A durable Session created by a parent's `Agent` tool. It belongs to the same configured Agent and Tenant, retains its creation parent Session/Turn/tool-use identity, and shares the Workspace and Sandbox binding by default. It does not copy the parent conversation. `childId` is the Session ID; `resume` submits a new Delegation Input to that same Child Session.
_Avoid_: plugin child, business subtype, temporary agent

**Delegation Input**:
A durable task prompt accepted by `Agent`, either for a new Child Session or for `resume`. Every input has its own **Delegation Execution**, calling Session/Turn/tool-use identity, execution mode and budget. Inputs for the same Child Session execute serially.
_Avoid_: new Agent configuration, user message (its origin is delegation)

**Delegation Execution**:
The persistent association between one Delegation Input and its child Turn. It records effective configuration, status, input, calling identity, outcome and trace. The execution ID distinguishes initial delegation from later resumes of the same Child Session. A model step is one model request within an execution, not an OMA Turn; the Host assigns 500 steps by default to each execution, including resume. The parent cannot override the budget; budget exhaustion returns a status for the parent to decide whether to resume.
_Avoid_: childId (the Child Session can contain multiple executions)

**Delegation Result**:
A durable outcome for one Delegation Execution, with terminal reason, output and child trace reference. Asynchronous results appear in parent history immediately and become model input only when claimed. Synchronous results finish the waiting tool in the original Turn. A result reports execution facts and does not certify that generated artifacts satisfy the task.
_Avoid_: user message, completed artifact, callback Promise

**Loop**:
An Agent-owned recurring instruction. On each due interval the Host creates a fresh **Workspace** and **Session**, links the Session to the Loop, durably records the Loop's prompt as the Session's first pending input, and then starts its first **Turn**. Every scheduled occurrence creates a new Session; a Loop does not reuse a previous Session or Workspace. Missed intervals coalesce into one occurrence when scheduling resumes, and a manual run does not move the recurring cadence. The console nests the Sessions created by a Loop beneath that Loop on the Agent page.
_Avoid_: cron job, scheduled Session (the Loop is the schedule; each occurrence creates a Session)

**Turn**:
One accepted input and the Agent execution that responds to it within a **Session**. The input can be a user message, a **Delegation Input**, or a claimed **Delegation Result**. A synchronous delegation waits within the original Turn; an asynchronous result may start a later Turn.
_Avoid_: request, job, invocation

A Turn's durable `session.turn_completed` Event ends that Turn independently of
Session status. Queued Input starts another Turn without an intermediate
`session.status_idle`. The last input's acknowledgement atomically removes it
and commits Session idle plus its lifecycle Event when the queue is empty.
Completion is durable before acknowledgement, so recovery can finish queue
cleanup without repeating Agent execution. The console uses Turn completion for
per-Turn stream cleanup and file refresh, and Session lifecycle Events for status.

**Interrupt**:
A user's demand that the **Session**'s currently running **Turn** stop now. An Interrupt targets that one Turn only: input the user has already queued still runs afterwards, and the Session stays usable. It is a request about the present, not an edit of the past — whatever the Agent had already produced remains part of the Session's history.
_Avoid_: cancel, stop the session, kill (an Interrupt ends a Turn, not a Session)

**Queued Input**:
A user message, Delegation Input, or Delegation Result that the Host has accepted but is not yet executing. It is durable server state, not a client's optimistic guess: it survives a reload, and it outlives the **Turn** that was running when it arrived — which is why an **Interrupt** ends one Turn while the Queued Input behind it still runs. Input stops being queued the moment a Turn claims it, because claiming promotes it into the Session's history with its actual input source; so a given input is either queued or executing, never both.
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

For new Pi output, native `agent.context_entry` records own the content. Host
derives the existing Complete Event display shapes using metadata-only selectors
and stable reserved sequence positions, without storing duplicate display rows.
Runtime replay reads the original native entries; older histories keep their
existing display records. See ADR-0016.

**Agent File**:
A named markdown document that shapes an **Agent**'s identity or instructions (e.g. SOUL, IDENTITY, MEMORY, USER). Agent Files belong to one Agent and are isolated per Agent — one Agent can never read another's Files. They are Agent-scoped, not Session-scoped: every Session of an Agent sees the same Files. The Host assembles them into the instructions given to the runtime; the runtime never reads them from a Session's Workspace.
_Avoid_: prompt file, persona file, SOUL (as a category name)

**Skill**:
A self-contained, reusable capability packaged as a directory containing a `SKILL.md`. Every Skill has an **owner**: a **Library Skill** is owned by the tenant and lives in the **Skill Library**; an **Agent Skill** is owned by one Agent and exists only as that Agent's private copy (a **Skill Fork**). When a Session runs, the Host materializes that Agent's equipped Agent Skills into a resource location the runtime loads natively; a Skill is not a Session artifact and does not live in a Workspace.
_Avoid_: plugin, tool (a Skill may bundle tools, but is not itself a tool)

Skill names are unique within an owner: `(tenant, owner type, owner id, name)`.
Uploading an existing name on the Skill Library page requires explicit overwrite
confirmation. Agent-page imports and Upload & Equip overwrite existing copies by
default; already-equipped Library Skills remain selectable for re-import, with
same-name or already-equipped labels indicating which selections will overwrite.
The console sends `overwrite: true` to opt into the API's replacement behavior.
Replacement retains the Skill ID and
replaces the complete file tree; Library replacement leaves Agent forks independent.
Metadata and SKILL.md edits cannot rename a Skill to another Skill's name.

**Skill Library**:
The tenant-scoped collection of all **Library Skills** a tenant has, independent of any **Agent**. Skills are added to the Library once (by uploading a folder — one folder is one Skill if it holds a `SKILL.md`, or many Skills if its subfolders each hold one), previewed and edited there, and then equipped onto Agents as desired. The Library has its own card directory and Skill detail pages, with a file tree and preview/editor. An Agent page shows only its equipped Skills; users select Library Skills in a bulk-import dialog or upload a folder to equip it. A Library Skill can be equipped by many Agents; each equip produces an independent **Skill Fork**.
_Avoid_: marketplace, catalog, registry

**Equip** (a Skill onto an Agent):
To fork a **Library Skill** onto an **Agent**: the Host snapshots the Library Skill's files into a new **Agent Skill** (a **Skill Fork**) that the Agent's Sessions load. Equipping copies the Skill at that moment; later Library edits do not propagate to the fork. Unequipping removes the Agent's fork, not the Library Skill.
_Avoid_: install, add, attach, link (equip is a copy, not a reference)

**Managed MCP Connection**:
An Agent-scoped reference to an entry in the Host-owned **MCP Catalog**. The Agent may configure presentation metadata such as the connection's name and description, but never its executable, URL, headers, or environment-variable placeholders. The Host resolves the reference into its version-pinned runtime connection for each Turn; credentials stay in the Host environment and are never persisted in the Agent.
_Avoid_: custom MCP server, MCP config (users select a managed capability, not arbitrary connection details)

**MCP Catalog**:
The Host-owned allowlist of **Managed MCP Connections** available to Agents. Its public representation exposes safe metadata only; executable paths, endpoints, headers, and credential values remain private deployment configuration. Adding or changing an entry is a code/deployment and threat-model change, not an Agent edit.
_Avoid_: marketplace, MCP registry, user catalog

**Skill Fork**:
The Agent-owned copy produced when a **Library Skill** is equipped onto an **Agent**. The fork has its own id and records the `source_skill_id` it was forked from. From then on the two are independent: editing the Library Skill never changes the fork, and editing the fork on the Agent's page never changes the Library Skill. This is why an Agent can preview and edit its equipped Skills freely, and why deleting a Library Skill leaves already-equipped Agents unaffected.
_Avoid_: link, alias, reference (a fork is a copy, not a pointer)

**User**:
A human who signs in to the web console with a username and password. Registration requires a valid invite code. Each User is paired one-to-one with a **Tenant** created at registration time; a User has exactly one Tenant and a Tenant has exactly one User. A User's login produces a session token that resolves to that same **Tenant**, so everything the User sees (Agents, Loops, Sessions, Skills, API keys) is scoped to their Tenant.
_Avoid_: account, member, person

**Tenant**:
The isolation boundary that owns everything in the system — **Agents**, **Loops**, **Sessions**, **Skills**, **API keys**. Historically a Tenant was an implicit identifier with no record of its own. It is now created together with a **User** at registration (one-to-one). A request reaches a Tenant through one of two credentials that both resolve to the same `tenantId`: an **API key** (`x-api-key`, for machines) or a **User**'s session token (`Authorization: Bearer`, for humans). API keys a User creates while signed in belong to that User's Tenant.
_Avoid_: org, organization, workspace, account

**Workspace**:
The Tenant-owned persistent file tree in OSS that a **Session** binds immutably at creation. Many Sessions may share one Workspace concurrently and may overwrite the same file. Its only persistent Sandbox path is `/home/user/workspace`; HOME `/home/user`, dependencies and caches remain local. A successful write followed by successful close saves that file independently of Turn success. Interrupt and Session deletion retain already saved files. There is no Turn transaction, rollback, automatic history migration, versioning or undo.
_Avoid_: Tenant, home directory, snapshot, Turn output transaction

## Sandbox provisioning

**Sandbox Manager**:
The single owner of a sandbox's lifecycle — create, reclaim, rebuild, list, describe — shared by both the Sandbox-as-Tool mode and the future Agent-in-the-Sandbox mode. It reads an **Environment Spec** to know what to build and verifies its mounted Workspace before execution, refreshes Read-only Projections, and releases execution resources. It knows no Agent runtime or business ownership policy; the Host supplies trusted storage coordinates.
_Avoid_: sandbox pool, orchestrator, lifecycle pool, executor

Controlled Sandbox idle reclamation uses explicit root Session bindings. Each
running Turn and every Queued Input across the binding protects its Sandbox.
After all actual executions settle and the queues empty, a confirmed idle
observation starts a continuous 30-minute period. New input invalidates it.
Expired leases, Host loss and bounded Interrupt cleanup do not prove execution
has stopped: unknown activity retains the resource without a maximum age.
Managed Sandboxes have no gateway deadline. Reclamation preserves the mounted
Workspace, while temporary files, processes and local dependencies may be lost.
See ADR-0017 and `docs/sandbox-lifecycle-deployment.md`; production-wide rollout
is not enabled by default.

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

## Console deletion

Session and Workspace deletion from the sidebar is a `deleted_at` marker only.
It does not terminate execution or delete records, events, queued input or files.
Lists hide deleted Sessions and Sessions belonging to a deleted Workspace.
The console uses `POST /v1/sessions/{id}` with `deleted: true`; the existing
`DELETE /v1/sessions/{id}` remains the separate execution-termination operation.
Deleted Workspace IDs cannot be reused to create new Sessions.

## Workspace file API

Workspace files are accessed through `/v1/workspaces/{id}/files`, using the
authenticated Tenant and Workspace metadata. Reading a file returns a short-lived
OSS GET URL and metadata; browsers and programs fetch its bytes directly from
OSS without API credentials. This is the single read entry point for text,
media previews and downloads. A Session is not required. Running Sessions do not lock file
writes; concurrent writes to the same path may overwrite each other. See
ADR-0009 and ADR-0012.

## Session sharing

Large tool results (at least 64 KiB of event JSON), including native Pi results
and Delegation checkpoint copies, are stored as immutable OSS payloads. The event
journal keeps references; Host runtime reads restore the original data. Session
history and SSE expose only metadata for these results. The console loads complete
content only when expanded, without thumbnails. See ADR-0015 for the read contract
and the migration required to evacuate existing inline PG data.

A **Session Share** is a permanent random read capability for exactly one
Session and its entire bound Workspace. Owners create/retrieve the same link
when copying it. Visitors need no login and read current persisted content on
refresh, including files written by other Sessions sharing that Workspace.
They receive no access to those other Sessions, Agent configuration, or execution
controls. Session or Workspace soft deletion invalidates each subsequent API read;
already-issued OSS links remain usable until expiry (ADR-0012).
termination alone does not. History is shared verbatim, not automatically
redacted. See ADR-0011 and the `SessionShareAuth` OpenAPI security scheme.

## API and Runner roles

The **API** owns authenticated HTTP ingress and SSE delivery. The **Runner** owns
SessionRouter execution, PG pending-input discovery, Loop scheduling, delegation
coordination and Sandbox cleanup. Both use PostgreSQL as the only durable history
and pending-input authority; Redis carries transient Deltas and lightweight
notifications. Open SSE connections catch up committed PG events during Redis
outages. API accepts Interrupt and termination without holding execution objects.
Termination writes a retryable cleanup outbox and a durable lifecycle Event.
Unknown Sandbox execution is retained until actual settlement; recording activity
for cleanup does not enable the controlled idle-reclamation rollout.
See ADR-0018 and `docs/api-runner-operations.md`.
