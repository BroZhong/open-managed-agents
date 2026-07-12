# ADR-0006: Managed Host-resident Pi extensions

## Status

Accepted. Amends ADR-0002 and ADR-0003 for a narrow class of managed Pi
extensions; all filesystem, command, and workspace operations remain governed by
ADR-0002 and ADR-0005.

## Context

ADR-0002 deliberately made the injected per-`run()` `ToolExecutor` the only
route from Pi into a Workspace and its Sandbox. It also described the Adapter as
a stateless translator that touches no infrastructure. Three Pi extensions now
provide capabilities that do not operate on a Workspace:

- `pi-web-access` performs public web search and content retrieval;
- `pi-mcp-adapter` connects to an administrator-approved remote MCP server;
- `@tintinweb/pi-subagents` creates child Pi sessions for delegated reasoning.

These extensions are discovered by Pi's `DefaultResourceLoader` and execute in
the Host process. Pretending that they pass through `ToolExecutor` would hide a
real trust-boundary change. `pi-mcp-adapter` also accepts its runtime server list
only as a config-file path, while MCP configuration is owned by an Agent and can
differ between concurrent Turns.

## Decision

### 1. Host-resident extensions are an explicit, managed exception

The deployment may install a version-pinned allowlist of Host-resident Pi
extensions. They may expose network or orchestration tools, but may not read,
write, list, or execute inside a Workspace. Pi's built-in filesystem and command
tools remain disabled whenever a `ToolExecutor` is present; those operations
continue to use the Sandbox-backed custom tools from ADR-0002.

Users cannot install arbitrary Host extensions through an Agent definition.
Adding another extension requires a code/deployment change and an update to this
threat model.

The initial controls are:

- Web access is read-only public-network retrieval and receives no per-Agent
  secret configuration.
- MCP accepts only the exact managed `rds-mcp` URL, transport, and
  `Authorization: Bearer ${RDS_MCP_APIKEY}` placeholder. The API rejects all
  other endpoints and headers, preventing Agent-authored SSRF and arbitrary Host
  environment interpolation. The real credential exists only in the Host
  environment.
- Child Agents are text-only reasoning sessions. The extension's three default
  Agent types are disabled and scheduling is off. The deployment publishes one
  `storyboard-stage` type whose authoritative frontmatter pins the model and
  forces `tools: none`, `extensions: false`, `skills: false`, foreground mode,
  and `isolated: true`. The parent Agent alone owns Sandbox-backed tools. For
  multi-stage Skill workflows, the parent passes each child the required stage
  context, receives text, and writes artifacts or invokes `vfs-cli` itself.

### 2. Extension lifecycle is scoped to one managed Turn

SDK consumers explicitly bind extensions before prompting and emit
`session_shutdown` before disposing the Pi session. Startup failures still
dispose the partially-created session. This prevents MCP connections, child
watchers, and extension state from surviving a Turn.

### 3. MCP file materialization is a narrow Adapter bridge

The Host remains the owner of persisted Agent configuration and credentials.
Until `pi-mcp-adapter` exposes an in-memory configuration API, the Pi Adapter may
translate the already-validated `agent.mcpServers` value into a per-Turn,
mode-`0600` temporary file and set the extension's public `mcp-config` flag on
that Turn's isolated resource loader.

The file contains placeholders, never resolved secret values. It is removed on
normal completion, abort, prompt failure, and extension-startup failure. The
Adapter may not reuse a shared config path, mutate process arguments, persist
the file, or perform the MCP network call itself. This is an SDK-format bridge,
not a general infrastructure seam.

## Consequences

- The Host process now has intentionally bounded outbound network capability;
  extension upgrades require the same security review as adding a new Host
  integration.
- `ToolExecutor` remains the sole Workspace/Sandbox boundary, but is no longer
  claimed to mediate unrelated Host network and text-only delegation tools.
- The managed RDS policy is duplicated at the API and console presentation
  boundaries. Exact-match tests are required at both boundaries; if a second
  managed MCP resource is added, expose a Host-owned catalog instead of adding
  more duplicated constants.
- Child Agents cannot directly produce files. The parent-mediated artifact flow
  is a deliberate safety tradeoff and must be visible in end-to-end event logs.
- Replace the temporary-file bridge if `pi-mcp-adapter` gains a supported
  in-memory configuration API.
