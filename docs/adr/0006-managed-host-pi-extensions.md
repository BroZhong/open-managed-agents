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
- `pi-mcp-adapter` connects to an administrator-approved HTTP or stdio MCP
  server;
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
- MCP accepts only references from a Host-owned catalog. An Agent persists a
  catalog id plus configurable presentation metadata (`name` and optional
  `description`); it cannot persist a command, arguments, URL, headers, working
  directory, or environment-variable placeholders. The API rejects unknown ids
  and extra connection fields. This prevents Agent-authored command execution,
  SSRF, and arbitrary Host environment interpolation. Existing exact-match
  `rds-mcp` records remain internally readable and resolvable as a migration
  compatibility shape, but create/update requests cannot write that legacy
  URL/header form. Public Agent and Session responses project those rows back to
  the safe catalog reference and never return the stored connection details.
- The initial catalog contains the exact managed `rds-mcp` HTTP connection and
  the Aliyun RDS Supabase Sessions stdio connection. The latter is a
  version-pinned Host facade over the same Alibaba Cloud discovery credentials
  as the interactive Codex MCP, but it does not launch that upstream server:
  upstream instance connection performs `GRANT` and may install an arbitrary-SQL
  function, which is unsuitable for an unattended Loop. The facade exposes one
  `query_recent_sessions` tool, obtains instance metadata and credentials through
  the read-only Alibaba Cloud describe APIs, and sends one fixed `SELECT` to the
  instance's postgres-meta endpoint. Tool input can change only bounded day,
  Session, and per-Session event limits; it cannot provide SQL, schema/table,
  tenant, endpoint, or instance identity. The Host injects `OMA_TENANT_ID` from
  the running Agent plus `${ALIYUN_ACCESS_KEY_ID}`,
  `${ALIYUN_ACCESS_KEY_SECRET}`, and `${ALIYUN_REGION}`. The stdio environment
  also carries the Codex-wrapper aliases `${ALIBABA_CLOUD_ACCESS_KEY_ID}` and
  `${ALIBABA_CLOUD_ACCESS_KEY_SECRET}`; the reader uses either alias only when
  its corresponding `ALIYUN_*` value is empty. An optional
  deployment-owned `${ALIYUN_SUPABASE_INSTANCE}` disambiguates multiple running
  instances. The deployment must also explicitly include the authenticated
  Tenant in the comma-separated `${OMA_SUPABASE_ALLOWED_TENANTS}` value. A
  missing/empty value fails closed: the catalog omits the Supabase entry, Agent
  create/update rejects its catalog id, and per-Turn resolution independently
  refuses to inject the deployment credentials. Results are bounded, event
  payloads are truncated, and infrastructure identifiers/credentials are
  redacted. The public catalog
  endpoint exposes descriptive metadata, transport, configurable fields, and
  required environment-variable names, but never the connection definition or
  any resolved value.
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
resolve each persisted catalog reference into the current Host-owned connection,
translate that already-validated value into a per-Turn, mode-`0600` temporary
file, and set the extension's public `mcp-config` flag on that Turn's isolated
resource loader. Resolving per Turn means a catalog security correction takes
effect without rewriting historical Agent records.

Every managed Turn receives an explicit file, including
`{ "mcpServers": {} }` when its Agent has no Managed MCP Connections. The pinned
`pi-mcp-adapter@2.11.0` source overlay makes a supplied override exclusive: it
loads only that validated file, discards its `imports`, and does not merge the
generic global, Pi global, shared project, or Pi project configurations. The
extension's pre-`session_start` registration phase is forced to an empty config
and cannot discover or register ambient direct tools. The image build checks the
exact package version, pristine SHA-256 values for both patched files, and unique
source anchors, so an upstream change fails closed.

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
- The MCP allowlist is centralized in a Host-owned catalog instead of duplicated
  between API validation and console presentation. Tests must prove that public
  catalog output omits private connection fields and that persisted references
  resolve only to exact catalog definitions.
- The interactive `@aliyun-rds/supabase-mcp-server` remains mutation-capable and
  is deliberately not the runtime behind this catalog entry. The managed facade
  makes the unattended capability structurally read-only: no arbitrary SQL is
  accepted, the only SQL template contains `SELECT`/CTEs, redirects are denied,
  and the tenant is Host-bound per Turn. Prompt wording and Codex-client approval
  metadata remain non-boundaries; the facade and downstream Tenant predicate are
  the actual boundary. Changes to its fixed query, describe APIs, endpoint, or
  exposed tools require a new threat-model review.
- Catalog credentials are deployment-scoped capabilities. The online alpha
  exposes the Aliyun Supabase entry only to exact Tenant ids in
  `OMA_SUPABASE_ALLOWED_TENANTS`; listing, API acceptance, and runtime resolution
  all enforce the same fail-closed policy. A future multi-tenant deployment
  should replace this static allowlist with per-tenant credentials and policy.
- Child Agent tool calls are summarized inside the parent `Agent` tool result;
  end-to-end evidence must prove both repeated delegation and the resulting
  Sandbox/remote artifacts.
- Replace the version-pinned subagent source overlay when upstream exposes a
  supported child `customTools` provider.
- Replace the temporary-file bridge if `pi-mcp-adapter` gains a supported
  in-memory configuration API. Replace its version-pinned source overlay only
  when that API also guarantees exclusive managed configuration and disables
  ambient early direct-tool discovery.
- Replace the managed Skill input transform if Pi exposes a native Skill command
  expander that accepts content through an abstract read capability instead of
  Host `readFileSync`.
