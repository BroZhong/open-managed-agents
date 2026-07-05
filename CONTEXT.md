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
A self-contained, reusable capability packaged as a directory containing a `SKILL.md`. Skills live in a tenant-scoped **Skill Library** and are first-class: one Skill can be equipped by many **Agents**, and one Agent can equip many Skills (many-to-many). An Agent references the Skills it has equipped by identity, not by copy. When a Session runs, the Host materializes that Agent's equipped Skills into a resource location the runtime loads natively; a Skill is not a Session artifact and does not live in a Workspace.
_Avoid_: plugin, tool (a Skill may bundle tools, but is not itself a tool)

**Skill Library**:
The tenant-scoped collection of all **Skills** a tenant has, independent of any **Agent**. Skills are added to the Library once (by uploading a folder — one folder is one Skill if it holds a `SKILL.md`, or many Skills if its subfolders each hold one) and then equipped onto Agents as desired. The Library is managed from the same entry page that lists Agents; equipping happens on an individual Agent's page.
_Avoid_: marketplace, catalog, registry

**Equip** (a Skill onto an Agent):
To reference a **Skill** from the **Skill Library** on an **Agent** so the Agent's Sessions load it. Equipping does not copy the Skill; unequipping removes only the reference.
_Avoid_: install, add, attach

## Example Dialogue

Developer: "Should this Agent run directly in the API service?"

Domain expert: "No. For the online alpha, make it a Sandboxed Agent so each Turn runs in the sandbox and the Session can preserve working state."
