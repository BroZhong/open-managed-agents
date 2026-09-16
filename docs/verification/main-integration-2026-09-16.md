# Main integration and Session isolation follow-up — 2026-09-16

The original Session mixing incident and production research evidence are retained in [real-subagent-research-2026-09-16.md](real-subagent-research-2026-09-16.md). The cause was a Redis stream keyed only by a Session-local Turn ID. The fix requires Session identity on every stream operation and never replays ambiguous legacy streams.

## Integration

The delegation branch was rebased onto `def855e071834c324fd306b967590b2e6f4e47fc` (PR #144). The integration preserves Skills uniqueness, sidebar rename/soft delete, tool disclosures, Skill selection and draft/scroll behavior. The user's later UI requirements take precedence over the new top usage disclosure: stopped Sessions have no badge, and Child Sessions open in peer tabs.

- Renumbered the delegation migration to `0012_durable_delegations.sql`, following main's `0011_skill_names_and_soft_delete.sql`. The SQL remains compatible with its earlier deployed filename.
- New child creation now respects Workspace soft deletion, including a concurrent deletion transaction. Previously accepted calls remain idempotent and existing Child Sessions can still execute or resume; soft deletion does not terminate work.
- Added parent/child hook and page regressions using identical event/Turn/block/delta IDs, independent completion/unmount, and child close/reopen from its own durable cursor.
- Updated OpenAPI import-test inventory for the four delegation routes and five schemas. Redis tests and typechecks now run in CI.

## Validation

- Store/Memory/Router/Sandbox/API: 782 passed, 8 optional integration tests skipped; all five typechecks passed.
- Redis: 42 passed; Event Log/MCP Catalog: 36 passed. Their typechecks passed. Total Server verification: **860 passed, 8 optional tests skipped**.
- Adapter: 389 passed; all adapter typechecks passed.
- Web: 272 passed; typecheck, production build and changed-file lint passed.
- Apifox contract scripts: 65 passed. OpenAPI generation/check passed with four existing warnings.
- Deployment tests: 6 passed, 1 optional test skipped.
- Separate real PostgreSQL tests passed for deleted-Workspace admission, idempotent replay, continued execution/resume and concurrent deletion locking.
- An isolated PostgreSQL schema validated `0011` followed by `0012`, then repeated both migrations: duplicate Skill backup/reference rewrites, existing parent/child/delegation records, interrupt columns and application-role permissions were preserved. Temporary schema/role were removed and the test container stopped.

## Release boundary

The previously verified release was `738c128bf426`. During this follow-up, another task released main `def855e07183`; live Deployment inspection confirmed that both Server and Web had changed. That main commit predates durable delegation and Session stream isolation. The integrated version must therefore be released again after merge. Earlier verification reports identify their historical release, not the current production image.
