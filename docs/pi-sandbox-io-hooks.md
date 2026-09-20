# Pi tools through the public SDK

The seven managed tools use Pi 0.83.0's public `customTools` interface. Host
reuses their schema and prompt metadata; actual native execution occurs in a
short-lived Node process inside the ToolExecutor's Sandbox. No native tool
execute or filesystem-aware TUI preview runs on Host. There is no Pi SDK patch.

`custom-tools.ts` carries a versioned JSON request and streaming response through
the existing ToolExecutor. `sandbox-tool-runtime.ts` calls only public SDK tool
factories. Pi owns paths, matching, image processing, pagination, edit algorithms,
search arguments, truncation and tool results using the Sandbox's own OS.

Workspace remains `/home/user/workspace`, home is `/home/user`, and absolute
Skill projection and temporary output paths remain accessible inside Sandbox.
Bash full output lives in Sandbox and is readable by the same native read tool.
The Adapter keeps remote canonical-path locks across write/edit processes and
separate queues per executor filesystem.

The image installs a lockfile-pinned, unmodified SDK at `/opt/oma-pi-tools`.
Runtime version mismatch and missing installation fail closed. Build/verify the
new Sandbox image and rebuild existing bindings before shipping the Host change;
old images do not silently fall back to Host execution. For LocalToolExecutor
experiments, set `OMA_PI_TOOL_MODULE` in its child environment to an installed Pi
0.83.0 `dist/index.js` (the test suite does this explicitly).

Tests compare native tool results across in-process and executor-process paths,
and separately forbid Host I/O during every registered tool and renderer.
Equivalent OS, binaries and environment are required for exact output parity.
The E2B byte-stream patch remains a transport concern; no third-party extension
fs/child_process code is virtualized by this protocol.

See [ADR-0014](adr/0014-public-pi-sdk-boundary.md).
