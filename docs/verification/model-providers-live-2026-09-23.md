# Live provider verification — 2026-09-23

Completed at 15:57 UTC (23:57 Asia/Shanghai). These are real upstream requests,
distinct from the mocked automated tests for the new provider configuration UI.

## Scope and source

- Live Host: `oma-infra/oma-server-78d46f9c8-bpc6l`, image `5b81574adf03`.
- Read the actually mounted `/opt/pi-agent-seed/models.json` and `auth.json`.
  Four configured Host providers contain eleven model selections.
- Google: `sandbox-system/base-secret`'s `GOOGLE_API_KEY` and the active
  Sandbox model setting `GEMINI_VIDEO_MODEL=gemini-3.8-flash`.
- Host inference used the installed, unmodified Pi 0.83.0 `ModelRuntime`,
  configured endpoints, model metadata and resolved credentials. Each request
  asked for `OK`, allowed at most 1,024 output tokens and had a 60-second deadline.
  At most two inference requests ran concurrently. Rate limits were not retried.
- Separately ran the worktree's `discoverCustomProviderModels`,
  `testCustomProvider` and guarded `providerFetch` in an isolated temporary
  directory on Host. This used the new feature's 128-token probe and the actual
  models returned by each endpoint. The temporary directory was removed.

No credentials or raw authentication responses were written into this report.
No production configuration, deployment, Agent or Session was changed. Google
credentials were transferred only in memory to an isolated Host probe.

## Model discovery

| Provider | Effective endpoint | Live result |
| --- | --- | --- |
| Kimi Coding | `https://api.kimi.com/coding/v1/models` | 200; 4 models |
| BigModel Coding | `https://open.bigmodel.cn/api/coding/paas/v4/models` | 200; 11 models |
| DeepSeek | `https://api.deepseek.com/models` | 200; 2 models |
| OpenAI gateway | Configured internal sub2api `/v1/models` | 200; 17 models, using Pi-resolved authentication |
| Google | `https://generativelanguage.googleapis.com/v1beta/models` | 61 models through an explicit proxy; configured model is listed |

An initial OpenAI list probe used the model configuration's key directly and
returned 401. Repeating it with `ModelRuntime.getAuth(model).auth` returned 200.
The latter is authoritative: it uses the same credential resolution as actual
inference. The 401 is not evidence that the production gateway key is invalid.

## Inference for every configured model

Success means a non-error completion containing exactly `OK`.

| Provider | Model | Result |
| --- | --- | --- |
| Kimi | `k3` | Passed, 4.12 s |
| BigModel | `glm-5.3` | Passed, 1.02 s |
| DeepSeek | `deepseek-flash` | Passed, 0.53 s |
| OpenAI gateway | `gpt-5.3-codex-spark` | 429: all available upstream accounts rate-limited |
| OpenAI gateway | `gpt-5.4` | 429: all available upstream accounts rate-limited |
| OpenAI gateway | `gpt-5.4-mini` | 429: all available upstream accounts rate-limited |
| OpenAI gateway | `gpt-5.5` | Passed, 1.45 s |
| OpenAI gateway | `gpt-5.6-luna` | Passed, 1.53 s |
| OpenAI gateway | `gpt-5.6-sol` | Passed, 2.99 s |
| OpenAI gateway | `gpt-5.6-terra` | Passed, 3.04 s |
| OpenAI gateway | `gpt-6-astra` | Passed, 3.10 s |
| Google | `gemini-3.8-flash` | Passed, 2.83 s, with probe-only explicit proxy |

Thus eight Host model selections passed and three were rate-limited. Google
passed with a network override; it must not be counted as working with the
unchanged deployment network configuration.

## Google network diagnosis

The Sandbox Google SDK list request timed out. The Host probe's normal HTTPS
list request also failed with `UND_ERR_CONNECT_TIMEOUT`; Pi inference returned
`fetch failed`. The Host environment had a configured `HTTP_PROXY`, but no
non-empty `HTTPS_PROXY` or `OMA_PROXY_URL`. Host startup's explicit global proxy
setup reads `OMA_PROXY_URL`, `HTTPS_PROXY`, or `https_proxy`, not `HTTP_PROXY`.

In an isolated probe only, installing Undici's `ProxyAgent` with the existing
`HTTP_PROXY` value made both the Google model list and Pi inference succeed.
This verifies the credential and model while identifying the HTTPS egress gap.
The deployed proxy variables and dispatchers were not changed.

The installed Pi catalog also lacked `gemini-3.8-flash`. To exercise its native
Google implementation, the probe registered that exact online-configured model
through Pi's public `registerProvider` API in memory, with a conservative output
limit. It did not change the deployed Pi catalog. The request used text only;
this is not a video/audio capability test.

## New custom-provider feature acceptance

| Configuration | Endpoint discovery | Feature's actual Pi probe |
| --- | --- | --- |
| Kimi Coding / `k3` | Passed, 4 returned models | Passed |
| BigModel Coding / `glm-5.3` | Passed, 11 returned models | Passed |
| DeepSeek / `deepseek-flash` | Passed, 2 returned models | Passed |
| Internal OpenAI gateway | Rejected by public HTTPS endpoint policy | Not run through this feature; managed runtime results are above |
| Google native protocol | Not implemented in this form | Not implemented in this form; separate native Pi result is above |

Google's successful native probe does not establish Google support in the new
configuration UI. That UI currently offers only OpenAI Chat Completions, OpenAI
Responses and Anthropic Messages. No Anthropic provider credentials were present
in the inspected online configuration, so no live Anthropic test was claimed.

These probes cover configured selections, not inference for every model returned
by discovery. They do not establish tool calling, multimodal input, long-context
behavior or sustained availability. In particular, returned model IDs are not
evidence of available quota.
