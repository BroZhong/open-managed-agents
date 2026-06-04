# ADR-0001: Sandbox Architecture for Adapter Execution

## Status

Accepted

## Context

We need to run AI coding agents (Claude Code, Codex, Pi) in isolated environments to prevent uncontrolled side effects on the host system. The adapter layer translates agent events into a unified `SessionEvent` stream. We evaluated two integration models:

- **Agent in the Sandbox**: The entire adapter + agent CLI runs inside a sandbox container. Agent operates on the sandbox filesystem directly, unaware of isolation.
- **Sandbox as Tool**: Agent runs locally, but its tool calls (Bash, Read, Write) are intercepted and proxied to a remote sandbox.

We investigated tool interception capabilities across agent runtimes:

| Runtime | Can hook tool execution transparently? |
|---------|---------------------------------------|
| oh-my-pi (Pi Agent) | Yes — via Extension `registerTool` + `setActiveTools`, or RPC `host_tools` |
| Claude Code | No — `PreToolUse` hooks can only block/modify, not replace execution |
| Codex | No — requires Rust-level `ExecBackend` trait implementation |

Since Claude Code (the primary adapter) cannot support transparent tool interception, "Agent in the Sandbox" is the only universally applicable model.

## Decision

### 1. Agent in the Sandbox

The adapter process runs inside an OpenSandbox container. The adapter code is unchanged — it spawns agent CLI processes that read/write the sandbox filesystem directly. The adapter has no awareness of being inside a sandbox.

### 2. Server manages sandbox lifecycle

The server (orchestrator) is solely responsible for sandbox lifecycle:

- **Create**: On first turn of a session
- **Pause**: After each turn completes (releases compute, snapshots rootfs as OCI image)
- **Resume**: Before the next turn (restores from snapshot, seconds-scale)
- **Kill**: When session ends

The adapter layer has no sandbox-related code or interfaces.

### 3. Pause/Resume for state preservation

Using OpenSandbox's Pause/Resume mechanism (rootfs snapshot → OCI image → registry). This preserves the complete filesystem state across turns, including installed packages, agent-created files, and configuration changes.

### 4. Communication via execd

Server communicates with the adapter inside the sandbox through OpenSandbox's `execd` daemon:

1. Server writes `AdapterInput` as JSON to `/tmp/input.json` via `sandbox.files.write()`
2. Server executes `node adapter-runner.js /tmp/input.json` via `sandbox.commands.run()`
3. Adapter-runner reads input, instantiates the adapter, and streams `SessionEvent` objects as JSONL to stdout
4. Server collects events via execd's SSE streaming of stdout

### 5. Sandbox constraint in AdapterInput (future)

A `sandbox` field in `AdapterInput.constraints` will declare the isolation level:

```typescript
constraints?: {
  timeoutSeconds?: number;
  sandbox?: "none" | "read-only" | "workspace-write" | "full-access";
};
```

This is a declaration for the server to interpret when provisioning the sandbox. The adapter itself never reads this field.

## Consequences

- **Adapter layer remains unchanged** — no sandbox abstractions, interfaces, or dependencies added
- **New component: `adapter-runner.js`** — a thin script that reads an input file, runs the adapter, and outputs JSONL to stdout
- **Server gains sandbox orchestration responsibility** — using OpenSandbox JS SDK for lifecycle management
- **Cold start cost** — first turn requires `Sandbox.create()` (tens of seconds). Subsequent turns use Resume (seconds).
- **Snapshot storage** — each Pause produces an OCI image tag; registry GC policy needed
- **Future extensibility** — "Sandbox as Tool" mode can be added later for Pi Agent using its Extension API, without changing this architecture
