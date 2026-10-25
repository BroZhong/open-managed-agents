# SubAgent tab release — 2026-10-25

## Source and image

- Source commit: `462e1ac15ca4891d113151e6927fd7354ade4f08`.
- Branch: `codex/subagent-session-tab` (pushed; not merged into main).
- Built from the exact committed checkout on `vfs-dev`, using
  `deploy/scripts/build-images.sh --push web`.
- Image tag: `462e1ac15ca4`.
- Image: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:b479ad63dd99faa1bd1f5fa01d009107be4b836cd241a14b573eba1ab170409c`.

## Deployment

Released to `agent-platform/oma-test` first, then `agent-platform/oma-infra`.
Test used the complete rendered overlay with its existing API and Runner image
`afcea76b87ed`; the preflight diff showed only the Web image change.
Production used a JSON patch guarded by the previous Web image and container
name, after a server-side dry run. Both Web Deployments completed their rollout
with one updated, ready replica. No database migrations were required.

Previous Web images retained for rollback:

- Test: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web:740ac31d0ceb`.
- Production: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:103378b0fce5f16f9d521f3e02f42d3cec7ce0bc72014db0a871385e79b64e6b`.

## Verification

- 22 relevant component/Session tests passed; Web build, changed-file ESLint,
  and `git diff --check` passed before release.
- Both public `/api/health` endpoints returned `{"status":"ok"}`.
- Both public HTML documents reference `index-CdgXMwPq.js` and
  `index-DMhOOZJQ.css`. Downloaded JavaScript matched byte for byte, SHA-256
  `79e3c567c420d23e0f12a97ee34baac85ed5c01733204251e2fb84f098066fa5`,
  and includes the new SubAgent UI.
- Authenticated browser verification on test: a Session without delegation
  shows the SubAgent tab and its empty state.
- Authenticated browser verification on production: an existing regression
  Session lists three completed Child Sessions using task prompt summaries;
  clicking one opens the existing Agent detail tab and loads its conversation
  history and usage footer.
- Browser acceptance only read existing Sessions; no model work was submitted.

The SubAgent list uses the latest Delegation Input prompt per Child Session,
deduplicates resumed executions across pages, and reuses the existing child
Session viewer. Loading, retry and pagination are covered by component tests;
the Session integration test covers reuse of an already-open child tab and
preservation of parent draft/scroll state.
