# Pi SDK integration

Pi 0.83.0 is installed unmodified in Adapter and Server. The former Pi patch has
been removed; neither workspace declares a Pi `patchedDependencies` entry.

- Public `customTools` dispatch the seven native tools into the Sandbox, where
  an unmodified SDK owns their execution and OS access.
- Public extension events, `getEntries`, `streamFunction`, `setSessionFile` and
  `sendCustomMessage` implement context persistence, import and continuation.
- Gateway errors use the public per-Agent `streamFunction` wrapper.

See [ADR-0014](../../docs/adr/0014-public-pi-sdk-boundary.md) for boundaries and
tradeoffs. The Server's E2B raw-output transport patch remains independent.
