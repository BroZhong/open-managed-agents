# Nautilus

An orchestration platform that runs AI coding agents (Pi, Claude Code, Codex) as multi-user sessions, translating each runtime's output into a unified event stream and surfacing the agent's file artifacts to a frontend.

## Language

### Runtime & translation

**Adapter**:
A stateless translator between a unified event stream and one agent runtime's SDK session. It converts session history into the runtime's context and the runtime's output back into events. It never touches persistence, messaging, sandboxing, or storage.
_Avoid_: Connector, driver, integration

**Runtime**:
A concrete agent backend the platform can drive — Pi, Claude Code, or Codex. Each has one Adapter.
_Avoid_: Engine, backend, provider

**Host**:
The resident, multi-user process that owns everything an Adapter refuses to touch: building context, persistence, messaging, sandbox lifecycle, and artifact storage. In this repo the Host is the Server.
_Avoid_: Orchestrator (ambiguous), gateway

### Conversation

**Session**:
One conversation between a user and an agent. Bound to exactly one Workspace at creation; the binding never changes.
_Avoid_: Conversation, thread, chat

**Turn**:
One round within a Session: a user message and everything the agent emits in response until it goes idle.
_Avoid_: Round, exchange, step

**Event**:
An immutable, sequenced record of something that happened in a Session — a message, a tool use, a status change. The authoritative log of a Session is its ordered Events.
_Avoid_: Log entry, record

**Delta**:
A token-level increment of an in-progress agent message. Deltas exist only to animate live output; once a Turn ends, their content is captured whole as an Event. Deltas are never part of the authoritative log.
_Avoid_: Chunk (overloaded), partial, fragment

### Filesystem & isolation

**Workspace**:
The persistent, authoritative home of a Session's file artifacts. Identified by a Workspace ID that is either user-supplied or auto-created. One Workspace may be bound by many Sessions concurrently. There is only one kind of Workspace — "temporary" merely means its ID was auto-generated, not that its data is impermanent.
_Avoid_: Project, folder, directory, environment

**Sandbox**:
A short-lived, stateless execution environment for one Session's tool calls. Created lazily on first filesystem/code tool use, hydrated from the Workspace, synced back, then destroyed. Holds no authoritative state.
_Avoid_: Container, VM, box

**Sandbox-as-Tool**:
The isolation model where the agent runs in the Host and only its tool calls are proxied into a Sandbox. Contrast with Agent-in-the-Sandbox, where the whole agent runs inside the Sandbox.
_Avoid_: Tool proxying, remote execution

**Hydrate**:
Populating a freshly created Sandbox's filesystem from the Workspace's authoritative store before the agent runs.
_Avoid_: Restore, seed, load

**Sync**:
Writing a Sandbox's filesystem changes back to the Workspace: a full scan (to catch files created by any means, including shell), content-hash comparison to push changes, and a baseline diff to propagate deletions.
_Avoid_: Snapshot, backup, flush

**Artifact**:
A file produced by an agent inside a Workspace, surfaced to the frontend.
_Avoid_: Output, product, deliverable
