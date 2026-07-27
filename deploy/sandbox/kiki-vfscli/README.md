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
credential is installed. `VFS_TOKEN` remains a runtime secret injected by the
OMA Host and is never baked into the image.

## Build and push

Download `vfs-cli_v0.2.19_linux_amd64.tar.gz` and its checksum from the official
`welltop-cn/vfs-cli-dist` release, verify the checksum, then run:

```bash
VFS_CLI_SRC=/absolute/path/to/vfs-cli \
AGENT_SKILLS_SRC=/absolute/path/to/Agent-Skills \
PUSH=1 \
./build.sh
```

The build fails unless the Agent-Skills worktree is at the exact decoupling
commit and its decoupling guard passes.

## Deploy

```bash
KUBECONFIG=/path/to/cloud-agent-hk-config \
kubectl apply -f ../sandboxset-kiki-vfscli.yaml

KUBECONFIG=/path/to/cloud-agent-hk-config \
kubectl -n sandbox-system get sandboxset kiki-open-managed-agents
```

The Kiki Agent must opt in with:

```json
{
  "runtime": "pi-agent",
  "mcpServers": [],
  "sandbox": {
    "enabled": true,
    "image": "kiki-open-managed-agents"
  }
}
```

Its system instructions must load applicable workflows from
`/opt/agent-skills/<skill-name>/SKILL.md` and use only `vfs-cli` for VFS data
operations.
