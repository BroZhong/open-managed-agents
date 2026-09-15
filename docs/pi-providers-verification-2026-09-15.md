# Pi provider and default Sandbox verification — 2026-09-15

## Configuration

The production Pi catalog in `oma-infra/oma-pi-gateway` now contains:

| Selection | Endpoint | Upstream model |
| --- | --- | --- |
| `kimi-coding-plan/k3` | `https://api.kimi.com/coding/v1` | `k3` |
| `bigmodel/glm-5.3` | `https://open.bigmodel.cn/api/coding/paas/v4` | `glm-5.3` |
| `deepseek/deepseek-flash` | `https://api.deepseek.com` | `deepseek-flash` (V4.1 Flash) |

K3 replaces the previous Ark route under the existing provider selection.
The existing `openai-codex` provider and `auth.json` are preserved exactly.
The three supplied keys live only in the Host Secret, not source or images.

The BigModel key has a working Coding Plan entitlement. The general API
endpoint rejected a request with code 1113 (no pay-as-you-go balance); the
Coding Plan endpoint accepted the same model and key. GLM-5.3 supports a
1,000,000-token context and up to 131,072 output tokens. K3 uses the verified
1,048,576 context and a conservative 32,768 output limit. DeepSeek uses a
1,000,000 context and a conservative 384,000 output limit.

## Runtime verification

Before rollout, each provider was tested with the production-installed
Pi SDK 0.80.10 using a temporary candidate catalog and in-memory credentials.
Each test made two streamed requests: call a harmless `lookup_code` tool,
then consume the supplied result and return the exact verification code.
All three completed with stop reasons `toolUse` and `stop` and sent
`reasoning_effort: max`. Prior assistant reasoning content was retained on
the second request. BigModel also sent `thinking.clear_thinking: false`.
No probe messages or Agent records were inserted into user Sessions.

The final pre-rollout read-only database check at 09:32:17 UTC found zero
running Sessions, zero pending inputs, and zero active claims. Secret and
Web image updates passed server-side dry runs. The Secret update included a
resource-version guard; the Web update guarded the previous image digest.

## Web release

The Agent form no longer offers a Sandbox template selection. New Agents
omit `sandbox.image` and use the existing Host default `auto-story-v2`.
Saving an Agent with the old `auto-story` choice clears that override while
retaining its environment. Other explicitly configured custom templates
remain unchanged. Existing Agents are not bulk migrated.

The Web image was built on `vfs-dev` from an isolated checkout based on the
live Web release `2f21683`. Only the four form/model files were added; unrelated
working-tree changes were excluded. Release commit:
`fb4e9b79264e92a60ba540e57a2b3a33858dfbfa`.

Image:
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-web@sha256:49c264169d496abe5d87d6dd37c71530d90ec2efd6f4a0e7c7c5d7ff7edd900e`.

The Server image remains:
`registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:890410d167e01ab6b1e2add87341a70e4b54d4ca82c8c4e149b874cb5ecee757`.

Web JS: `index-BF1Dsb19.js`, SHA-256
`a36880fd8a284fbe5e8a9861f0e864c9309200152dfb9acfc25828fa1d24783e`.

## Checks

- Pi Adapter suite: 204 passed; final model catalog check: 16 passed.
- Web suite: 232 passed; isolated form/model checks: 9 passed.
- Pi TypeScript check and Web TypeScript/Vite build passed.
- Published image is linux/amd64; `nginx -t` passed.
- See [Pi model configuration](pi-models.md) for official provider references,
  context limits, credential names, and subscription-cost metadata.

## Final production result

Both Deployments rolled out successfully. Final ready Pods have zero restarts:
`oma-server-78cc8b99f8-tnzz5` and `oma-web-65766b59bb-7l6mv`.
The public health endpoint returned HTTP 200 with `status: ok`. Public HTML
loads `index-BF1Dsb19.js`, whose hash exactly matches the verified release.

After rollout, all three probes were repeated against the actual mounted
production catalog. Each again completed the streamed tool round trip at
maximum effort. The live Secret exactly matches the tested final candidate;
its auth data is unchanged and the Kimi provider no longer contains an Ark
endpoint. Temporary credential/probe files were removed after verification.
