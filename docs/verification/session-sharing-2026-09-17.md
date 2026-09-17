# Session and Workspace sharing verification

Scope: #154 and #155. Disposable local in-memory HTTP Host and Vite console;
production services and existing user data were not modified.

Subsequent authorized production deployment and real PostgreSQL verification
are recorded separately in [the release report](session-sharing-release-2026-09-17.md).

## Automated checks

- HTTP: concurrent idempotent creation; owner/API-key permissions; mixed
  credentials; random-ID format and forgery; same/cross Tenant and Child Session
  boundaries; JSON history pagination; configuration allowlist; SSE and write
  rejection; unchanged queue, Session and files after rejected writes; current
  file reads; traversal/encoding; termination and soft deletion.
- PostgreSQL implementation through HTTP: 16 concurrent creates and a new
  store/application instance retain one share ID. This run uses pg-mem; real
  PostgreSQL concurrency is not claimed. `PG_TEST_URL` enables the same test on
  a disposable PostgreSQL database using the existing harness.
- DOM tests: opening/closing does not create; first copy creates; clipboard retry
  and reopening reuse the ID; anonymous multi-page history; file navigation and
  read-only text; missing-file feedback and a download via an authenticated Blob
  request and browser anchor; refresh updates history and files; login token preservation;
  invalid-share feedback.
- Full suites: server 871 passed, 8 skipped (external integration prerequisites);
  web 344 passed; adapter 403 passed. Typechecking passed for server workspaces,
  web and adapter. Web production build passed. OpenAPI generated-contract check
  and lint passed (four existing documentation warnings).

## Browser checks

- Owner dialog: computed preview height 240px, outer and inner overflow hidden,
  gradient mask present. First copy displays 已复制.
- Same link opened in a second tab while owner is logged in: 104 persisted
  events across two HTTP pages; no message composer or file mutation actions.
  Child links render as text. Conversation report link opens read-only text.
- Image preview loads from a Blob URL. Audio and video use the existing media
  preview controls and Host reads; both report a one-second duration with no
  media errors. Download button interaction produced no UI error, but the browser
  automation download event timed out; download dispatch is verified in DOM tests.
- After signing out through the console, reloading the share still succeeds.
  Adding a persisted event and updating report.txt through owner HTTP calls is
  reflected by manual share refresh (105 events and updated report text).
- After owner Workspace deletion, refreshing files in the open share immediately
  replaces the page with 分享已失效, without navigating to login.

## Release requirement

Apply `deploy/migrations/0013_session_shares.sql` before deploying the Host when
schema initialization is disabled. No production migration or deployment was
performed by this implementation task.

## Code review

Independent Standards and Spec reviews compared the implementation with starting
commit `13c61c011a3262f76cc626c451da2de7d869cd4c`. Final follow-up changes only
extended download/missing-file verification and this report.

### Standards

0 findings. No documented-standard violations or actionable baseline smells.
The implementation follows ADR-0011's credential precedence, resource and
operation allowlists, minimal Session projection, deletion checks, isolated
anonymous request context, and read-only Workspace access. The store and
migration implement the documented permanent, atomic, idempotent share binding.
Domain naming follows CONTEXT.md and docs/agents/domain.md.

### Spec

0 findings. The implementation covers persistent share IDs, explicit operation
and resource restrictions, mixed-credential narrowing, display-only Session
projection, paginated history, isolated anonymous request/cache state, read-only
Workspace browsing, and deletion invalidation. No clear scope creep was found.
The PostgreSQL concurrency/process-restart validation limitation above remains;
it is not evidence of a functional defect.

Review totals: Standards 0, Spec 0; no confirmed issue in either axis.
