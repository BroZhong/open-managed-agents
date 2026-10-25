# oma-cli

Non-interactive TypeScript/npm client for OMA Agents, Sessions, Complete Events,
Workspaces, Skills and Environments. Requires Node.js >=22; no runtime npm dependencies.

```sh
npm ci
pnpm --dir ../server install --frozen-lockfile # real Host test dependencies
npm test
npm pack
# In an independent directory:
npm install /absolute/path/to/welltop-oma-cli-0.0.2.tgz
./node_modules/.bin/oma-cli --help
./node_modules/.bin/oma-cli guide read --name oma-cli --raw
```

This package is released manually from a verified tarball. Confirm npm ownership and
registry settings before each publication.

Configure `OMA_BASE_URL=https://oma.example.test/api` and a private `OMA_API_KEY`.
Corresponding flags override environment values. No production URL is built in.
Use `schema <command path>` for the complete contract and `doctor` for read-only
diagnostics. [Bundled guide](guides/oma-cli.md) documents all workflows and recovery.

`oma-cli environment create|get|list|update|delete|rebuild|logs` defines what Sandboxes run:
a Base Image (`oma-base`, or `oma-media` with FFmpeg), an init script
(`--init-script @init.sh`) and variables (`--env NAME=VALUE`, `--env-file`,
`--secret NAME=VALUE`, `--secret-file`; secrets are never shown again);
`--from <id>` copies one, including a read-only built-in. The script runs once
per build as root in /home/user and may use apt-get, pip and npm. Sandbox
commands start as login shells, so export a variable every command should
inherit from `/etc/profile.d/<name>.sh` as `export FOO="${FOO:-value}"`.
`oma-cli agent update --environment <id>` (or `--no-environment`) binds a ready
Environment an Agent's new Sessions run in; `session create --environment <id>`
overrides it for one Session. `environment logs --follow` prints the build log
every 2 s until the build ends; `environment rebuild` builds the current
definition again. See the guide's Environments section.

To upgrade an installation, install the newly verified tarball or the corresponding npm version.
Before any manual registry release: confirm package ownership, update version and
guide together, run typecheck/tests/pack verification, inspect `npm pack --dry-run`,
and verify the tarball contains no credentials. Only after separate publication
authorization run `npm publish <verified-tarball> --registry <approved-registry>`.
There is no automatic release workflow.

Repository development: `npm run typecheck`; `npm run build`; run focused tests
with `node --test test/<name>.test.mjs`, then `npm test` once for the whole suite.
