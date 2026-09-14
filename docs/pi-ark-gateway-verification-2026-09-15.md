# Pi Kimi route through Volcengine Agent Plan — 2026-09-15

The configuration and compatibility image are deployed and verified in
production. A new user Turn initially delayed cutover; the user explicitly
authorized immediate switching with possible interruption. The final activity
check found two running Turns before the authorized Host restart.

## Deployed configuration

Only the `kimi-coding-plan` provider in `oma-infra/oma-pi-gateway` was updated:

- Base URL: `https://ark.cn-beijing.volces.com/api/plan/v3`.
- Upstream model: `kimi-k3`.
- Credential: the user-provided Ark key, stored in the Secret's model config.
- Context window: 1,024,000, following the official Agent Plan example.
- Preserve the existing reasoning mapping, compatibility flags, and conservative
  32,768 maximum output setting.

The OpenAI provider and the mounted auth file are preserved. Credentials are
not included in source, this report, or verification output.

## K3 selection compatibility

Existing Agent records and the console select `kimi-coding-plan/k3`. Pi sends
the resolved model's ID directly, while Ark rejects `k3` and accepts `kimi-k3`.
The compatibility change resolves an absent `kimi-coding-plan/k3` against
`kimi-coding-plan/kimi-k3`. An explicitly configured `k3` still takes precedence;
other providers and model names retain their previous behavior. Agent records
and console selections can therefore stay unchanged.

Code commit: `beb8ee39dabdcb92df37bead2e4006daf1ff6825`.

Deployed Host image:
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:890410d167e01ab6b1e2add87341a70e4b54d4ca82c8c4e149b874cb5ecee757`.

## Verification

- The official Agent Plan documentation and OpenClaw configuration identify
  `kimi-k3` for this endpoint.
- A direct request for `k3` returned `UnsupportedModel`; the corrected
  `kimi-k3` request returned HTTP 200 and a complete short answer.
- The production-installed Pi SDK ran an in-memory candidate configuration
  through two streamed requests. The first produced the requested tool call;
  the second consumed its result and returned the expected value.
- Both requests sent `reasoning_effort: max`. The assistant reasoning content
  was preserved across the tool result. Stop reasons were `toolUse` and `stop`;
  streaming included thinking, text, and tool-call events.
- Resolver and Adapter tests: 58 passed. TypeScript and diff checks passed.
- Both Secret and Deployment patches passed server-side dry runs. An initial
  activity check blocked all mutations until the user authorized switching.
- The production rollout completed with Pod `oma-server-676978867c-rzkwt`
  ready and zero restarts. Public `/api/health` returned HTTP 200 and `status:ok`.
- A second Pi probe used the actual mounted production configuration and the
  deployed resolver. Selection `kimi-coding-plan/k3` resolved to `kimi-k3` at
  the new endpoint. Two streamed requests again completed the tool round trip
  at maximum reasoning, with stop reasons `toolUse` and `stop`.
- That production probe removed `KIMI_CODING_API_KEY` only from its own child
  process environment before initializing Pi. Successful requests demonstrate
  that this route no longer depends on the legacy environment variable.
- Exact comparisons confirmed that the OpenAI provider and `auth.json` were
  preserved. No Agent records were changed, and no probe messages were inserted
  into user Sessions.

Official references:
[Agent Plan overview](https://www.volcengine.com/docs/82379/2366394),
[OpenClaw configuration](https://www.volcengine.com/docs/82379/2373742).
