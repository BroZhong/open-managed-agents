# Shanghai Sandbox templates

The supported application template is `code-interpreter-vfscli` in the
`sandbox-system` namespace of Shanghai `agent-platform`
(`c4d4dbd36064d4341835496ed01023600`). It serves the E2B gateway
`sandbox.agentry.welltop.tech`. A `SandboxSet` name is its E2B template ID;
`Sandbox.create("code-interpreter-vfscli")` requests that template's warm pool.

Use these records together:

- [`sandboxset-code-interpreter-vfscli.yaml`](./sandboxset-code-interpreter-vfscli.yaml)
  records the verified Shanghai template, image digest, DNS/runtime settings,
  resource requests and `ali-shanghai` pull Secret reference.
- [`code-interpreter-vfscli/README.md`](./code-interpreter-vfscli/README.md)
  describes the image build, launcher, named Skill projections and supported
  local dependency installation paths.
- [`oss-workspace/README.md`](./oss-workspace/README.md) records the Agent
  Identity, scoped OSS mount, explicit-cluster commands, operational limits,
  isolated verification evidence and coordinated release gate.

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

[`sandboxset-code-interpreter.yaml`](./sandboxset-code-interpreter.yaml) is an
inactive stock-image reference with zero warm replicas. It has not been tested
as an application OSS Workspace template and is not a supported substitute for
`code-interpreter-vfscli`. Do not select or apply it as part of the release gate
without separately validating its runtime, tooling and mounted execution.
