# Environment UI production release — 2026-10-26

## Release

- Source commit: `1acc084cae8c4efcd713735f23b8933122ec5581`.
- Pushed branch: `codex/environment-inline-edit` (not merged into `main` by this release).
- Builder: `vfs-dev:~/workspace/yuzhong/open-managed-agents`.
- Build command: `bash build.sh --push web`.
- GitHub fetch on the builder stalled; the committed branch was transferred with a Git bundle and fetched locally instead. The clean builder checkout and image revision label match the source commit above.
- Image tag: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web:202610261826`.
- Deployed digest: `sha256:847ebd88d22f383554f0890f58ab260c06a9bb441936a1df72045927f4f2720f`.
- Previous Web digest: `sha256:4a78b4cc8339f9dbcd88e1544c71c2a90a3586417fe0ac4de4392c947570cee4`.

## Scope

Environment cards link to their details across the card surface. Copy opens a fork confirmation in both the list and detail pages. Description, variables and init script have independent inline editors with save/cancel; each submits only its own fields. Name and Base Image remain editable in Configuration. Build logs remain the final detail section, including while another section is being edited. Built-in Environments remain read-only.

No migrations or API, Runner, image-builder or Sandbox image changes were required.

## Deployment and checks

1. Local verification: 14 related Vitest tests passed, changed-file ESLint passed, TypeScript/Vite build passed, and `git diff --check` passed.
2. Built and pushed on vfs-dev. Registry digest and OCI revision label were verified.
3. Rendered the test overlay with existing server digests and the new Web digest. `kubectl diff` showed only the Web image change. Applied the full test overlay per the runbook; Web rollout succeeded.
4. Test browser checks: clicking card whitespace opened the detail page; Copy opened the fork dialog and Cancel returned to the list; description, variables and script editors could be open together and individually cancelled; the script editor offered `Save & rebuild`; the Build log remained last. Existing Environment data was not saved or rebuilt during these browser checks.
5. Updated only the production `oma-infra/oma-web` image using:

   ```sh
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra set image deployment/oma-web web=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:847ebd88d22f383554f0890f58ab260c06a9bb441936a1df72045927f4f2720f
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra rollout status deployment/oma-web --timeout=180s
   ```

6. Production rollout succeeded. Ready replicas: Web 1, API 1, Runner 3, image-builder 1. All three server workloads retained digest `sha256:fe579de40a083a88295e410b8f2db6d752d9a2694145acb6fc6f8449a1fc503d`.
7. Both public sites served `/assets/index-ThbiC_CM.js` with the new UI strings, and both `/api/health` endpoints returned `{"status":"ok"}`.
8. Production browser checks: reloaded the Env list, opened and cancelled the fork confirmation, then opened an existing Environment and confirmed all section edit buttons and the final Build section. No production Environment data was changed for verification.

Save payload isolation, secret preservation, error handling and cancelled-draft behavior were covered by automated tests; live checks did not submit edits or trigger builds.

## Rollback

```sh
kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra set image deployment/oma-web web=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:4a78b4cc8339f9dbcd88e1544c71c2a90a3586417fe0ac4de4392c947570cee4
kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra rollout status deployment/oma-web --timeout=180s
```
