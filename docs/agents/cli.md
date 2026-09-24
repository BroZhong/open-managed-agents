# Agent-Friendly CLI guidance

The OMA TypeScript/npm CLI lives in `cli/`. Guidance is adapted from
[vfs-cli](https://github.com/welltop-cn/vfs-cli), preserving the Agent-friendly
interface principles without importing Go/Cobra, VFS credentials, business logic
or release workflows. Issues #180–#196 are the approved first-version contract.

- Default to non-interactive commands and explicit IDs. No implicit current
  resource, resource name guessing, global force or automatic write retries.
- Register executable commands and metadata together. Help/schema/input validation
  consume the same flags, body fields, requirements, exclusivity and API mappings.
  Keep `cli/guides/oma-cli.md` current; it must work from the installed package.
- Keep data on stdout and errors/diagnostics on stderr. Preserve API names and
  absent optional fields. JSON is `ok/command/data/meta`, never `data.data`.
- Validate flags, body sources, duplicate fields, stdin use, paths and format
  conflicts before networking. Dry-run may read, never write remote/local targets.
- Treat multi-file operations as partial outcomes, not transactions. Preflight
  all conflicts; do not claim atomic remote overwrite prevention. Downloads must
  reject symlinks and commit complete temporary files without implicit overwrite.
- Signed Workspace fetches use no Host headers. Redact credentials and sensitive
  bodies from errors, diagnostics and plans. Never store real keys in fixtures.
- Complete Event streams use frame-local durable IDs; never infer persistence
  from inherited lastEventId. Wait depends on PR #179’s queue-drain contract,
  observes Session state and drains all events, not pending preview or one Turn.
- Tests run the built CLI against controlled HTTP/SSE fixtures. The Host contract
  integration uses actual repository Host/SessionRouter with memory stores.
  Live verification is opt-in and may only touch newly created authorized fixtures.
- The package has no runtime dependency on the monorepo. Actual public package
  name, registry rights and publishing remain separate decisions and authorization.

See `docs/oma-cli-design.md` and `docs/verification/oma-cli-2026-09-23.md`.
