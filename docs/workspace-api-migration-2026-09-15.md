# Workspace API migration — 2026-09-15

## Released behavior

All seven file operations now use a Workspace ID directly:

```text
GET    /v1/workspaces/{id}/files
GET    /v1/workspaces/{id}/files/{path}
PUT    /v1/workspaces/{id}/files/content
DELETE /v1/workspaces/{id}/files/content?path=...
POST   /v1/workspaces/{id}/files/rename
POST   /v1/workspaces/{id}/files/upload
GET    /v1/workspaces/{id}/preview-url?path=...
```

The production base URL is `https://agentry.welltop.tech/api`. A Workspace
does not require a Session. Tenant ownership is checked against Workspace
metadata before accessing OSS. Existing object prefixes and files are unchanged.
The console passes `session.workspaceId`, rather than the Session ID.

The seven old `/v1/sessions/{id}/workspace/*` operations and the deprecated
`POST /v1/sessions/{id}/messages` are removed with no compatibility aliases.
Agent invocation continues through `POST /v1/sessions/{id}/events` (HTTP 202).
Running Sessions no longer block Host file writes. Concurrent writes to the
same path may overwrite each other; see [ADR-0009](adr/0009-workspace-file-api.md).

The file list returns the Workspace's current files, including inputs and
intermediate files. It is not a separate collection of curated final deliverables.

## Release evidence

- Feature commit: `e4c7e5c` on `codex/workspace-file-api`.
- Image source commit: `b03292159488236b1783c9c7b29feeeef7a65e68` on
  `codex/workspace-api-release`. This also preserves the four Web files from
  the already deployed model choices/default Sandbox release; unrelated
  model configuration, credentials and working-tree files were not deployed.
- Build host checkout: `vfs-dev:~/workspace/yuzhong/oma-workspace-api-release`.
- Build command: `bash build.sh --push server web`.
- Image tag: `b03292159488` for `welltop/oma-server` and `welltop/oma-web`
  in `registry-vpc.cn-shanghai.aliyuncs.com`.
- Server manifest digest: `sha256:248671032b43e08c674f2d5281e91e2b174f4e78faa67f871c592cd6ea27eed9`.
- Web manifest digest: `sha256:4f00a8b756029f9fabce2e8dba6089e14aca250c05deccdb1361b0dea123bfe3`.
- Deployment: `agent-platform/oma-infra`, using
  `bash deploy/scripts/deploy-app.sh --tag b03292159488 --apply --confirm-production`.
- The guarded, single-key ConfigMap change corrects `PUBLIC_API_URL` to include
  `/api`. No model Secret was rewritten. Pre-release Session status had no
  running Sessions. Both Deployments became ready with zero container restarts.
- Public Web asset: `/assets/index-CQV_Jrec.js`; verified new file paths and
  preservation of the deployed model choices.

Subsequent test/report commits do not change the released runtime code.

## Verification

- API from the isolated release checkout: **384 passed, 1 skipped**; TypeScript passed.
- Web: **233 passed**; TypeScript and Vite production build passed.
- Apifox synchronization scripts: **56 passed**.
- Generated OpenAPI check passed (four existing lint warnings).
- The public live OpenAPI matches the candidate semantically: **54 operations,
  46 schemas**, including authentication, request/response fields and API base URL.
- Live E2E: **82 HTTP checks passed**, covering an unbound Workspace, text and
  binary upload, multiple files, Unicode and special characters, empty files,
  prefix listing, rename, byte-exact downloads, signed OSS GET without API auth,
  invalid paths, authentication, shared/terminated Sessions and removed routes.
- Real `pi-agent` with `kimi-coding-plan/k3`: Host input was read through the
  mounted Workspace using bash, copied into an Agent artifact, then listed
  and read through the new API with exact content comparison. A Host write
  also succeeded while that Session was observed in `running` state.
- Local authenticated OSS integration tests additionally verify two Tenants
  sharing the same Workspace ID remain isolated.

Reproduce against an authorized environment:

```sh
export OMA_API_URL=https://agentry.welltop.tech/api
# Set OMA_API_KEY securely in the environment; do not commit it.
export OMA_E2E_MODEL=kimi-coding-plan/k3
node server/test-workspace-api.mjs
```

Omit `OMA_E2E_MODEL` for file API and mock Turn checks only. The real model
mode performs a model call and creates a Sandbox. The script terminates its
Sessions, removes its Agents and deletes its files even on failure. The two
Workspaces created during verification retain only metadata, as the public
API has no metadata deletion operation. No API key or signed URL is recorded.

## Apifox status

The main Apifox project now has all seven new endpoints under **Workspaces /
Files**, and none of the old Session file paths. All seven public endpoint
pages were fetched and checked for the new path and correct `/api` base URL.
For example: [List Workspace files](https://f2imdh2qly.apifox.cn/515382558e0.md).

Full semantic readback still fails for the previously identified Apifox
limitations: 50 protected operations lose effective authentication, four
example-related differences remain, and multipart upload loses `anyOf` while
adding `type: object`. These are 56 comparison differences, not runtime API
failures. Main-branch AI write permission has not been changed. The earlier
repair branch predates this migration and must not be merged without rebasing
or regenerating its endpoint changes, or it would restore old URLs.

The CI readback check intentionally reports these differences rather than
declaring a successful import fully synchronized.
