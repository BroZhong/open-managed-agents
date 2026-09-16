# Model retry and sandbox utility changes — 2026-09-16

## Cross-session investigation

Read-only PostgreSQL queries used the running Host's existing connection with
`default_transaction_read_only=on` (the first aggregate used `BEGIN READ ONLY`
and rollback). Queries joined `oma.events` and `oma.sessions`, scoped to the
Tenant owning `sess_Pruf9rh4wgqH_BJG9H514`; no other Tenant was queried.
The detailed sample starts at 2026-09-09 12:00 UTC (20:00 Asia/Shanghai) and ends
at query time on September 16. There were 90 Sessions with recorded events,
2,610 completed model spans and 31 durable Session error events in this sample.

These counts include child/test Sessions. Model spans include failed attempts;
the aggregate is not a count of successful calls. Error counts below represent
terminal errors retained by OMA, not every provider error that the SDK recovered
internally. No request bodies or credentials were selected.

| Model error | Events | Sessions | Handling |
| --- | ---: | ---: | --- |
| `stream_read_error` | 8 | 6 | Newly retryable; observed on gpt-6-astra and gpt-5.6-sol. |
| `upstream_error: Upstream service temporarily unavailable` | 1 | 1 | Newly retryable; observed on gpt-6-astra. |
| HTTP 429 `AccountQuotaExceeded` (five-hour quota) | 2 | 2 | Newly excluded from transient retry; observed on kimi-k3. |
| HTTP 401 invalid/expired API key | 1 | 1 | Requires valid credentials; remains non-retryable. |
| Missing Google API key | 1 | 1 | Requires provider configuration. |
| Unconfigured `openai-codex/gpt-5.3-codex` | 1 | 1 | Requires model configuration. |

Other durable errors were sandbox preparation, historical workspace storage,
partial-Turn recovery and model-step budget exhaustion; they are not added to
model transport retries.

The six Sessions with stream-read failures (times Asia/Shanghai):

| Session | Failure times |
| --- | --- |
| [sess_5aKNgCpqyAQwY7sylXPwo](https://agentry.welltop.tech/sessions/sess_5aKNgCpqyAQwY7sylXPwo) | Sep 14 11:16:10 and 11:23:50; also temporary upstream unavailability at 11:49:49 |
| [sess_1Rfcfh_Vvbr-vwyyZn9PS](https://agentry.welltop.tech/sessions/sess_1Rfcfh_Vvbr-vwyyZn9PS) | Sep 14 22:49:30 |
| [sess_w_Ldzw0_2c4uJxlSSKZRK](https://agentry.welltop.tech/sessions/sess_w_Ldzw0_2c4uJxlSSKZRK) | Sep 15 00:54:23 |
| [sess_JHsZTceog3g8xbAaewTQq](https://agentry.welltop.tech/sessions/sess_JHsZTceog3g8xbAaewTQq) | Sep 16 11:30:01 (gpt-5.6-sol) |
| [sess_ANzfkrGRExjxk5ysAgqBj](https://agentry.welltop.tech/sessions/sess_ANzfkrGRExjxk5ysAgqBj) | Sep 16 17:01:08 |
| [sess_Pruf9rh4wgqH_BJG9H514](https://agentry.welltop.tech/sessions/sess_Pruf9rh4wgqH_BJG9H514) | Sep 16 18:53:39 and 20:02:42 |

Configuration/quota failures requiring a different remedy:

- Five-hour Kimi quota: [sess_tJbx1AQsYYKiBoRFA-rQx](https://agentry.welltop.tech/sessions/sess_tJbx1AQsYYKiBoRFA-rQx)
  and [sess_58i3U75pVJDmCXPkeLPpU](https://agentry.welltop.tech/sessions/sess_58i3U75pVJDmCXPkeLPpU).
- Invalid/expired key: [sess_WQuCGJ2h1_JkiqO0QDtSc](https://agentry.welltop.tech/sessions/sess_WQuCGJ2h1_JkiqO0QDtSc).
- Missing Google key: [sess_A5CteUS09dbfeIi_V0W_u](https://agentry.welltop.tech/sessions/sess_A5CteUS09dbfeIi_V0W_u).
- Unconfigured model: [sess_3ZibW1NiEqeDeTQwSGACn](https://agentry.welltop.tech/sessions/sess_3ZibW1NiEqeDeTQwSGACn).

## Implementation

- Uses the public per-Agent `streamFn` hook to normalize gateway errors in the
  adapter; pi-ai 0.80.10 is unmodified and both lockfiles retain their original
  dependency hashes. SDK bounded exponential backoff keeps completed tool results
  rather than replaying a Host Turn. Pi exposes no custom retry-classifier hook.
- Maps `stream_read_error` to `Network error`, temporary unavailability to
  `Service unavailable`, and `AccountQuotaExceeded` to `Quota exceeded`. The
  original error remains verbatim after the category prefix. This reuses Pi
  classification, including permanent-limit precedence over HTTP 429.
- Added checksum-pinned official Linux amd64 ossutil 2.2.0 preparation and
  independent Docker binary verification. `OSSUTIL_SRC` supports the same
  verified binary offline. No runtime credentials are packaged.
- Only the maintained auto-story-v2 recipe (`sandbox/auto-story-v2/`) installs
  ossutil, Debian procps (`ps`) and unzip. Its offline acceptance now checks
  the CLI version/help, visibility of its own process, and ZIP extraction with
  verified contents, as the non-root sandbox user on the minimal PATH.

## Verification

- Without adapter normalization: four of six real SDK continuation cases failed (missing
  stream/unavailability retries and unwanted quota retry).
- With adapter normalization against unmodified pi-ai: all seven SDK cases pass,
  including retry-budget exhaustion, disabled retries and authentication failure.
  Every model attempt checks that prior user input and the completed tool result
  are preserved exactly once. Eight stream tests cover parameter/signal forwarding,
  raw diagnostics, account-limit precedence, cancellation, success and exceptions.
- Durable execution tests: 11 passed; Pi adapter tests: 41 passed (67 tests total
  including the SDK and stream cases). Pi adapter TypeScript check passed.
- Sandbox package: all 98 tests and its TypeScript check passed.
- Build-script dry-run targets auto-story-v2 using the maintained auto-story
  recipe. The v2 deployment manifest passed Kubernetes server-side dry-run.
- Frozen-lockfile installs passed in both adapter and server workspaces.
- Official ossutil download and archive/binary SHA-256 verification passed.
- A corrupt `OSSUTIL_SRC` override was rejected before any executable was staged.
- Python compilation and shell syntax validation passed for changed scripts.
- The complete auto-story recipe built successfully on `vfs-dev`. All 14
  offline acceptance checks passed, including the new utilities, native search,
  Gemini SDK, media processing and exclusion checks. The inherited ACS Jupyter
  startup remained healthy and ENTRYPOINT/CMD matched the base. See
  [machine-readable acceptance results](sandbox-runtime-tools-2026-09-16.json).
- Verification images (local to the build host, not pushed):
  `oma-sandbox:retry-tools-verification`, manifest digest
  `sha256:e5fed8debb09e0e1b7182104c3b1202832d7355c33f58abfdf54b88bbf5ad8b4`.

The first auto-story build used the original smoke-test snapshot, which called
the unsupported `ossutil help cp` command. Corrected to `ossutil cp --help`,
verified against ossutil 2.2.0, and rebuilt auto-story using cached
layers; the complete acceptance and startup checks above passed on that final
source. Slow upstream downloads were handled by reusing previously cached,
checksum-verified release inputs; the recipe's version/hash checks were retained.

Production rollout is separate: these source changes do not update the running
Host or existing Sandbox instances. No production rollout or model/media
generation was performed as part of this work.

## Sole maintained template

The build and deployment entrypoints now accept only `auto-story-v2`. The SDK
fallback and live verification script match the Host ConfigMap's existing v2
default. The v2 manifest was captured read-only from the active Shanghai pool;
its published image digest and Secret references are preserved. Older templates
are marked as historical references, and this change no longer updates their
package recipes. No cluster resources were changed.
