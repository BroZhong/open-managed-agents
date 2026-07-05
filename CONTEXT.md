# Open Managed Agents

Open Managed Agents coordinates long-running AI coding agents across sessions and turns while preserving their working state.

## Language

**Agent**:
A configured AI coding worker that can be used to create **Sessions**. An Agent has one runtime and may be configured to run as a **Sandboxed Agent**.
_Avoid_: bot, assistant, worker

**Sandboxed Agent**:
An **Agent** whose turns run inside an isolated sandbox environment. In the online alpha, all real agent execution is expected to use Sandboxed Agents.
_Avoid_: sandbox agent, isolated agent, Kubernetes agent

**Session**:
A conversation and work history for a single **Agent**. A Session contains one or more **Turns** and keeps the Agent's working state between turns when the Agent is sandboxed. An Agent owns many Sessions; a Session belongs to exactly one Agent. The console is entered through an Agent, and its Sessions are listed within it.
_Avoid_: chat, thread, run

**Turn**:
One user message and the Agent execution that responds to it within a **Session**.
_Avoid_: request, job, invocation

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

## Example Dialogue

Developer: "Should this Agent run directly in the API service?"

Domain expert: "No. For the online alpha, make it a Sandboxed Agent so each Turn runs in the sandbox and the Session can preserve working state."
