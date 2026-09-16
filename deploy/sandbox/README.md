# Shanghai sandbox

The sole maintained application template is `auto-story-v2` in the
`sandbox-system` namespace of Shanghai `agent-platform`. It serves the E2B
gateway `sandbox.agentry.welltop.tech`. The SandboxSet name is its E2B template
ID; `Sandbox.create("auto-story-v2")` requests that template's warm pool.

- [`sandboxset-auto-story-v2.yaml`](./sandboxset-auto-story-v2.yaml) records the
  active pool's pinned image, runtime, Secret references and resource settings.
- [`auto-story/README.md`](./auto-story/README.md) describes the maintained image
  recipe, including ossutil, procps (`ps`) and unzip. The directory and image
  release version remain named auto-story; the template ID is auto-story-v2.
- [`oss-workspace/README.md`](./oss-workspace/README.md) records the Agent
  Identity, scoped OSS mount, explicit-cluster commands and verification gate.

The older `auto-story`, `code-interpreter` and `code-interpreter-vfscli` manifests
and recipes are historical references, not maintained release targets. The
standard build and deploy scripts accept only `auto-story-v2`.

The Host computes a trusted `<tenantId>/<workspaceId>/` prefix after checking
Workspace ownership. It passes the CSI volume metadata to E2B; Agent Identity
issues storage credentials restricted to that bucket and prefix. Each Session
has its own disposable Sandbox, while Sessions bound to the same Workspace
share OSS files. `/home/user/workspace` is the mount-backed persistent root;
HOME remains local at `/home/user`, and Skills are projected under
`/skills/<skill-name>/`.

Before execution the application verifies trusted storage identity, the actual
`fuse.ossfs` mount, ordinary-user write/close/read and Host OSS readback from the
exact prefix. Failed verification blocks execution and permits a later retry.
It never creates a writable local Workspace fallback. Completed writes survive
Sandbox disposal, errors and Interrupt. Local dependencies and caches may be
lost on rebuild; there is no hydrate/checkpoint/upload synchronization cycle.

The final Host configuration in [`../k8s.yaml`](../k8s.yaml) requires the OSS
Workspace settings and the E2B credentials from managed secrets. Do not place
keys or tokens in these manifests or image layers. Requests from browsers
cannot supply arbitrary mount paths or prefixes.

Template changes and Host storage changes must follow the same approved
maintenance switch. Inspect active Sessions and effective per-Agent templates;
changing a default does not replace an existing Sandbox. Do not switch the web
Workspace store while affected execution still uses the prior storage path.
The inventory provides the explicit Shanghai kubeconfig procedure; all kubectl
commands should use it without changing the default context.
