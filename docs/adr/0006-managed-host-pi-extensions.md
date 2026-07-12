# ADR-0006: Managed Host-resident Pi extensions

## Status

Accepted. Amends ADR-0002 and ADR-0003 for a narrow class of managed Pi
extensions; all filesystem, command, and workspace operations remain governed by
ADR-0002 and ADR-0005.

## Context

ADR-0002 deliberately made the injected per-`run()` `ToolExecutor` the only
route from Pi into a Workspace and its Sandbox. It also described the Adapter as
a stateless translator that touches no infrastructure. Three Pi extensions now
provide Host-resident network/orchestration capability:

- `pi-web-access` performs public web search and content retrieval;
- `pi-mcp-adapter` connects to an administrator-approved remote MCP server;
- `@tintinweb/pi-subagents` creates child Pi sessions for delegated reasoning.

These extensions are discovered by Pi's `DefaultResourceLoader` and execute in
the Host process. Pretending that they pass through `ToolExecutor` would hide a
real trust-boundary change. `pi-mcp-adapter` also accepts its runtime server list
only as a config-file path, while MCP configuration is owned by an Agent and can
differ between concurrent Turns.

Managed Skills add a related command-expansion problem: Pi's native
`/skill:<name>` expansion reads `SKILL.md` from the Host filesystem, while this
system deliberately projects Skill bodies only into the Sandbox.

## Decision

### 1. Host-resident extensions are an explicit, managed exception

The deployment may install a version-pinned allowlist of Host-resident Pi
extensions. Pi's built-in filesystem and command tools remain disabled whenever
a `ToolExecutor` is present; every parent or child Workspace operation continues
to use the Sandbox-backed custom tools from ADR-0002.

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
- The subagent extension's three default Agent types are disabled and scheduling
  is off. The deployment publishes one `storyboard-stage` type whose
  authoritative frontmatter pins the model, requests all seven tools, and forces
  `extensions: false`, `skills: false`, foreground mode, and `isolated: true`.
  The managed overlay refuses to create the child if any corresponding custom
  implementation is absent, so an incomplete bridge cannot fall back to a Host
  builtin.
- Child Agents receive the parent's exact seven custom `ToolDefinition`s. Those
  definitions close over the same per-Turn `ToolExecutor`, so both sessions read
  and write the same Sandbox and can run `vfs-cli`; neither touches Host files.
  The child inherits the parent's system prompt (including equipped Skill
  descriptors), while Skill bodies remain projected inside the Sandbox.

### 2. Extension lifecycle is scoped to one managed Turn

SDK consumers explicitly bind extensions before prompting and emit
`session_shutdown` before disposing the Pi session. Startup failures still
dispose the partially-created session. This prevents MCP connections, child
watchers, and extension state from surviving a Turn.

### 3. Child custom tools use a per-Turn, fail-closed capability bridge

`@tintinweb/pi-subagents@0.13.0` has no public `customTools` provider for child
sessions. Each Adapter Turn therefore creates a fresh Pi `EventBus`. An inline
extension factory publishes that Turn's tool-definition array over a private
request/reply channel on the bus. The named extension already carries the
parent's `ExtensionAPI` into its child runner; a source overlay requests the
definitions there and passes them to the child `createAgentSession({
customTools, noTools: "builtin" })` call.

Tool definitions pass by reference inside one process. No capability is stored
in global state or serialized into prompts, files, arguments, or environment.
Concurrent parents own different buses and cannot request one another's tools.
The response handler is removed on `session_shutdown`; a missing response or
any missing `bash/read/write/edit/ls/grep/find` definition aborts child creation
rather than falling back to native tools. The package overlay checks the exact
package version, pristine source SHA-256, and exact source anchors during the
image build; an upstream source change fails the build.

### 4. MCP file materialization is a narrow Adapter bridge

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

All server entrypoints, including the dependency-light in-memory development
server, use this canonical SDK Adapter. A second CLI-spawning Pi adapter is not
permitted: it would bypass the per-Turn MCP materialization, extension
lifecycle, structured history, and managed Skill behavior described here.

### 5. Skill slash commands expand into an observable Sandbox read

For a Sandbox-backed Turn, a per-Turn inline input extension recognizes only an
exact `/skill:<name>` match from the Host-resolved `skillDescriptors`. It
transforms that input into an instruction that first calls the Sandbox-backed
`read` tool on the descriptor's projected `SKILL.md`, then follows the loaded
instructions with the user's arguments. Ordinary and unknown commands pass
through unchanged, matching Pi's native behavior.

The Host may use Skill metadata to build this instruction but must not open or
inline the Skill body. The real `read` call and result therefore remain visible
as Complete Events and are reconstructed in later structured history. A managed
Agent with projected Skill descriptors and no `ToolExecutor` fails loud rather
than asking Host-native tools to open a Sandbox-only path. Independent SDK
consumers may retain Pi-native expansion only when they supply real
Host-readable Skill paths without managed descriptors.

## Consequences

- The Host process now has intentionally bounded outbound network capability;
  extension upgrades require the same security review as adding a new Host
  integration.
- `ToolExecutor` remains the sole Workspace/Sandbox boundary, but is no longer
  claimed to mediate unrelated Host web/MCP network tools. Child Agents cross
  the same boundary through the exact same per-Turn definitions.
- The managed RDS policy is duplicated at the API and console presentation
  boundaries. Exact-match tests are required at both boundaries; if a second
  managed MCP resource is added, expose a Host-owned catalog instead of adding
  more duplicated constants.
- Child Agent tool calls are summarized inside the parent `Agent` tool result;
  end-to-end evidence must prove both repeated delegation and the resulting
  Sandbox/remote artifacts.
- Replace the version-pinned subagent source overlay when upstream exposes a
  supported child `customTools` provider.
- Replace the temporary-file bridge if `pi-mcp-adapter` gains a supported
  in-memory configuration API.
- Replace the managed Skill input transform if Pi exposes a native Skill command
  expander that accepts content through an abstract read capability instead of
  Host `readFileSync`.
