# E2B command output decoding

`e2b@2.24.0.patch` keeps a separate streaming UTF-8 decoder for each command's
stdout and stderr. E2B transport frames can split a multibyte character, so a
new decoder for every frame corrupts otherwise valid output before Pi receives
it. The patch preserves BOM text, keeps stdout and stderr independent, and
flushes pending bytes before recording the command's exit result. It applies
to both published entrypoints (`dist/index.js` and `dist/index.mjs`).

The server workspace pins the patch hash in its lockfile; image builds copy
this directory before installing dependencies. No API signature changes are
required. Rebase the patch against the exact SDK release on upgrades and run
the command stream regression tests through both actual SDK entrypoints.

## Control API connections

The same patch reads `E2B_API_CONNECTIONS` when the Node control API client is
first initialized. The value must be a positive safe integer; omission keeps
the SDK default of 100. This is the shared control API pool per Node process
(and per origin), not a count of Sandboxes or envd command streams. Changing
it requires restarting the Runner. The test overlay sets 200; production
keeps its existing default. `e2b-api-connections.test.ts` holds real local HTTP
requests to verify the default and configured limits through both module formats
and multiple clients sharing one pool. Keep the UTF-8 patch when updating it.
