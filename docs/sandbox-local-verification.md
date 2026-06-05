# Local OpenSandbox verification

This repo's local development path expects the sibling OpenSandbox server to run
with the Docker backend and the app server to connect to it at
`http://localhost:8080`.

## Setup

1. Start Docker Desktop.
2. Start the sibling OpenSandbox server from `../OpenSandbox/server`.
3. Build the sandbox image from this repo:

```sh
make -C sandbox build
```

4. Start the OMA dev API:

```sh
cd server
PORT=3100 AUTH_DISABLED=true OPENSANDBOX_URL=http://localhost:8080 pnpm dev:memory
```

For local Docker, use direct execd endpoints. Do not enable
`OPENSANDBOX_USE_SERVER_PROXY` unless specifically testing OpenSandbox's proxy
route. The dev servers force direct mode for localhost and log
`useServerProxy=false`; set `OPENSANDBOX_ALLOW_LOCAL_SERVER_PROXY=true` to
override that guard.

## Recommended image

Use `open-managed-agents/sandbox:latest`, built from `sandbox/Dockerfile`.
It includes:

- Node 22 and pnpm
- `tsx`
- Claude Code CLI, Codex CLI, and Pi agent CLI
- Python 3, pip, and venv for Python package persistence checks
- The adapter workspace at `/app/adapter`
- The agent workspace at `/workspace`

## Verified behavior

The local OpenSandbox deployment was verified with the JavaScript SDK using
direct execd endpoints:

- sandbox create and kill
- foreground command execution through execd stdout SSE
- file write/read through the SDK and execd
- pause/resume preserving files, npm packages, Python venv packages, and shell
  profile state
- multiple pause/resume cycles with resume latency under 100 ms locally
- pause during an active foreground command returns and the command can complete
  after resume
- Claude Code and Codex run inside the sandbox and stream parseable JSONL-derived
  `SessionEvent` records in real time

Observed local proxy issue: with `OPENSANDBOX_USE_SERVER_PROXY=true`, the local
OpenSandbox proxy route returned a 502 with an empty response body for
`/command`, while direct execd endpoints succeeded. The app dev server therefore
uses direct execd endpoints for localhost.
