# oma-cli

Non-interactive TypeScript/npm client for OMA Agents, Sessions, Complete Events,
Workspaces and Skills. Requires Node.js >=22; no runtime npm dependencies.

```sh
npm ci
pnpm --dir ../server install --frozen-lockfile # real Host test dependencies
npm test
npm pack
# In an independent directory:
npm install /absolute/path/to/oma-cli-local-0.1.0.tgz
./node_modules/.bin/oma-cli --help
./node_modules/.bin/oma-cli guide read --name oma-cli --raw
```

The local package name is not a public registry allocation. Public scope, registry
and publication rights must be confirmed separately. This work does not publish.

Configure `OMA_BASE_URL=https://oma.example.test/api` and a private `OMA_API_KEY`.
Corresponding flags override environment values. No production URL is built in.
Use `schema <command path>` for the complete contract and `doctor` for read-only
diagnostics. [Bundled guide](guides/oma-cli.md) documents all workflows and recovery.

To upgrade an unpublished installation, install the newly verified tarball.
Before any manual registry release: confirm package ownership, update version and
guide together, run typecheck/tests/pack verification, inspect `npm pack --dry-run`,
and verify the tarball contains no credentials. Only after separate publication
authorization run `npm publish <verified-tarball> --registry <approved-registry>`.
There is no automatic release workflow.

Repository development: `npm run typecheck`; `npm run build`; run focused tests
with `node --test test/<name>.test.mjs`, then `npm test` once for the whole suite.
