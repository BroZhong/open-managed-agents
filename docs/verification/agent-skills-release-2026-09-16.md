# Agent Skills release — 2026-09-16

Implementation: `b185d01de54955b86813ebdc8c409b29275a2f5a`, rebased onto main
`f0b481ccafa3597ef289b47526a63267098eb57d` and pushed on
`codex/agent-skills-workbench`.

## Integration and automated checks

Resolved six overlapping Session/Workspace files while preserving main's
chronological process groups, child execution navigation, compact usage footer,
Workspace names, and file:// Workspace links. Directory links now refresh the
listing before classification, expand their ancestors and never read a directory
as a file. Skill paths resolve to the current Agent's equipped private copy.

- Web: 330 tests passed; TypeScript and production build passed.
- API: 405 tests passed; one opt-in live Supabase test skipped.
- Server typecheck, OpenAPI generation/check, modified Web file ESLint, and
  `git diff --check` passed.
- Existing non-blocking warnings: Web main chunk exceeds 500 kB; OpenAPI lint
  reports four metadata/health-response warnings.

## Deployment

Built and pushed Server and Web from a clean isolated checkout on `vfs-dev`:
`/root/workspace/yuzhong/oma-release-agent-skills-b185d01`, using
`bash build.sh --push server web`.

Both application images have tag `b185d01de549`. Published manifest digests and
running container image IDs are recorded in the accompanying JSON evidence.

Released through `deploy/scripts/deploy-app.sh --tag b185d01de549`, first as a
server-side dry-run and then with `--apply --confirm-production`. Target:
Shanghai `agent-platform`, namespace `oma-infra`, public endpoint
`https://agentry.welltop.tech`. Before cutover, no running/waiting Sessions or
pending inputs were present. Both Deployments became ready and `/api/health`
returned `{"status":"ok"}`. Live OpenAPI exposes `forkAgent`. Public HTML serves
`index-Bv9SEQRL.js`.

## Production behavior

Authenticated Chrome verified the actual reported Session
`sess_V9CBoCe71zYQ3yimKNK2m`:

1. `chapters 目录` expands and selects `novels/73995/chapters`; the file pane
   shows its selection hint instead of a file 404. The Workspace name remains W1.
2. `正文 manifest` still opens the actual file in the editor.
3. The existing Read tool's `/skills/novel-fetch/SKILL.md` link navigates to
   `/agents/agent_Gm9zOmeyCQ6seu0O0XEwI/skills/skill_IWSyssZkDjOkLQst8Sbb1`.
   Its private Skill workbench lists five files and previews SKILL.md.
4. The global Library uses Skill cards. Delete actions show only their icons,
   while accessible names remain available.

A temporary Agent and two synthetic Library Skills verified the write path:

- New Agent starts with no equipped Skills even though the Library is populated.
- The UI's searchable multi-select imported both Skills with one confirmation.
- Editing an equipped Skill left its Library original unchanged.
- The UI Fork action created a new Agent and two new private Skill IDs, preserving
  Agent Files, current private edits and nested Skill files.
- Editing the Fork's Skill changed neither the original Agent nor the Library.

All twelve API assertions passed. Browser error/warning capture was empty.
The temporary Agents, Skills and their artifacts were removed, and all temporary
verification API keys were revoked. A final database check confirmed zero active
verification keys and zero remaining verification Agents. Existing user Sessions
and Workspace files were not modified and no model Turns were submitted.

Machine-readable evidence: [agent-skills-release-2026-09-16.json](agent-skills-release-2026-09-16.json).
