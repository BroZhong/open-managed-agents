# Kiki sandbox: decoupled Agent-Skills + vfs-cli

This is the dedicated sandbox image for the new open-managed-agents Kiki path.
It does not change the existing `code-interpreter-vfscli` template.

The image layers two independent inputs on the currently deployed Hong Kong
sandbox base:

- `Agent-Skills` commit `d17fb790112cc23809b27e38704dc0198b69c270`
  from branch `codex/decouple-skills-vfs-cli`; only the 12 entries enabled in
that commit's `registry.json` are copied to `/opt/agent-skills`.
- The official linux/amd64 `vfs-cli v0.2.19` release binary, installed at
  `/usr/local/bin/vfs-cli`.

The inputs are deliberately separate. Skills contain business workflows and
invoke the CLI; the CLI is not copied into a Skill, and no MCP server or MCP
credential is installed. `VFS_TOKEN` and its allowlisted project context remain
runtime values injected by the OMA Host and are never baked into the image.
They are attached only to a single, direct `vfs-cli` subprocess for the pending
Turn; they are not sandbox-global environment variables.

## Build and push

Download `vfs-cli_v0.2.19_linux_amd64.tar.gz` from the official
`welltop-cn/vfs-cli-dist` release. The build verifies the extracted binary
against the pinned SHA256
`b25a646a95a3bf4c19708dcef914f45d64bde4675cb06a2c9b3b25c7a0edad5a`,
then run:

```bash
VFS_CLI_SRC=/absolute/path/to/vfs-cli \
AGENT_SKILLS_SRC=/absolute/path/to/Agent-Skills \
PUSH=1 \
./build.sh
```

The build fails unless the Agent-Skills worktree is clean, is at the exact
decoupling commit, and its decoupling guard passes. Skills are copied from
`git archive` of that commit, never from mutable worktree files.

## Deploy

```bash
KUBECONFIG=/path/to/cloud-agent-hk-config \
kubectl apply -f ../sandboxset-kiki-vfscli.yaml

KUBECONFIG=/path/to/cloud-agent-hk-config \
kubectl -n sandbox-system get sandboxset kiki-open-managed-agents
```

The manifest pins the verified image index digest. Create the Kiki Agent from
[`agent.example.json`](./agent.example.json); it includes the required
`workspacePersistence: "ephemeral"`, empty MCP/OMA Skill lists, image alias,
and complete runtime instructions.

## Runtime credential boundary

The frontend sends `X-VFS-Token` and the allowlisted
`X-VFS-Project-Url`, `X-VFS-Project-Id`, `X-VFS-Teamwork-Id`,
`X-VFS-Storyboard-Id`, and `X-VFS-Runtime-Env` headers with each queued user
event. The Host validates them and stores them in a short-lived Redis entry
keyed by the generated Pending Event id, so token/project rotation and
multi-Host claim handoff resolve the values for the exact Turn. After the
pending event is acknowledged, the Host deletes the entry.

The token and project context are never stored in the Pending Event, Event Log,
Agent, Workspace, or sandbox creation environment. The per-Turn executor
exposes them only to one direct `vfs-cli ...` command and rejects shell control
operators. Arbitrary `env`, `echo`, pipelines, redirects, and compound shell
commands receive none of these values. The Agent's
`credentialMode: "runtime-vfs"` also strips the legacy deployment-wide
`VFS_TOKEN` while leaving old Agents unchanged.

The VFS token is never model-visible. The same non-secret project context is
also rendered into one transient Host-supplied system-prompt block for the
exact Turn. This lets the Agent pass an explicit storyboard argument even
though vfs-cli v0.2.19 resolves project/teamwork locators, but not storyboard
ids, from environment. The prompt block is built from the same Pending
Event-bound value as the process environment and is not appended to the Event
Log.

`vfs-cli` currently accepts authentication through process environment, so the
credential necessarily exists in that CLI process for the duration of the
command. The sandbox remains a trusted execution boundary; a pre-compromised
same-user process with `/proc` inspection capability is a residual risk. Use
short-lived, project-scoped VFS credentials when the VFS issuer supports them.
