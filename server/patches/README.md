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
