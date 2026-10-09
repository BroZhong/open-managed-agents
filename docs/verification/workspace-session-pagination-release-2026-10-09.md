# Workspace Session pagination release — 2026-10-09

The Agent sidebar now loads Sessions independently inside each Workspace. Opening
a project requests five top-level, non-Loop Sessions. Its Show more control
appends five more to that project; chats has its own cursor. Project discovery
is independent of the aggregate Agent Session list. The Agent detail page keeps
its aggregate list.

## Production release

- Web source: `ef96bd6fecc1` on `codex/agent-session-pagination`.
- API source: `84dbc295672a` on `codex/workspace-pagination-api-release`.
- The API release is based on production source `29201d1c28f96e64aab73a9b835a9747f66d70d2`.
  Its 202 tracked source and package manifests matched the previously deployed
  API. Only the seven production code files needed for Workspace filtering and
  discovery were changed, with matching tests and regenerated OpenAPI.
- Built on `vfs-dev` using the repository's `build.sh --push web` and
  `build.sh --push server` in isolated committed checkouts.
- Web image: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:34d7f5c8534637f89532b49965852b84b1083202c3de52e5a212071f2fefa27a`.
- API image: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:1ad22babd3e8c2ab153aee973ef5e88761776a9c365a0c5e405b5dbcd1e0fcc1`.
- Rolled `oma-api` first, verified the new filters, then rolled `oma-web` in
  `agent-platform/oma-infra`. Each image update used a server dry-run and an
  atomic test of the previously observed image before replacement.
- No database migrations were required. Runner image and Pod UID were unchanged.

## Verification

- Web: 56 test files, 433 passing tests, TypeScript and production build passed.
- API release checkout: 60 Session, Workspace and OpenAPI tests passed; API
  TypeScript passed. Store tests on the implementation branch: 159 passing,
  28 environment-gated skips, including 17 Session store tests.
- Public `/api/ready`: `{"status":"ok","role":"api"}`.
- Public Web serves `index-DzSv2dYC.js`; API, Web and Runner are ready `1/1`.
- Read-only checks against the supplied Agent found 97 parent Sessions: 90 in
  one named Workspace and seven loose Sessions. Workspace pagination returned
  18 pages of five; chats returned pages of five and two. Results exactly matched
  the aggregate parent list, with no repeated or omitted IDs. Invalid and
  conflicting filters returned HTTP 400.
- Authenticated Chrome UI: expanding the project displayed five Sessions.
  Its Show more appended five, retained the initial five, and left chats at
  five. Chats Show more then displayed all seven and disappeared; the project
  remained at ten. Screenshots are retained locally rather than publishing
  Session titles in the repository.

## Rollback

Restore Web first if rolling back both components, because the new sidebar
requires the new API filters. The previous compatible Web image (aggregate
Agent pagination) is
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:3b1740bc52a7973657239a143c8384bc723641978decbdd8cd9faac5b418bb99`.
The previous API image is
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:2e766b60d27aa8bf855090d633e1bb8241b41f39ce0ebae5f629126c12f63483`.
