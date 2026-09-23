# Pi model selection

Pi Agents can select these model ids in the console or the Agent API:

| Model | Agent `model` | Default Pi thinking | Provider effort |
| --- | --- | --- | --- |
| K3 (Kimi official) | `kimi-coding-plan/k3` | `xhigh` | `max` |
| GLM-5.3 (BigModel) | `bigmodel/glm-5.3` | `xhigh` | `max` |
| DeepSeek V4.1 Flash | `deepseek/deepseek-flash` | `xhigh` | `max` |
| GPT-6 Astra | `openai-codex/gpt-6-astra` | `max` | `max` |
| GPT-5.6 Sol | `openai-codex/gpt-5.6-sol` | `max` | `max` |

New Agents default to GPT-5.6 Sol, matching the local Pi model selection.
Editing an existing Agent preserves its model until another model is selected.
The runtime always selects the highest thinking level supported by that model,
including for the managed Storyboard Stage subagent when no explicit subagent
thinking override is supplied.

The Host uses Pi SDK 0.83.0, matching the local Pi installation. Earlier 0.80.3
releases cannot express the `max` thinking level. Each Turn creates one Pi
`ModelRuntime` that both resolves the model and authenticates its requests.
Custom providers and model overrides are loaded from the Host Pi agent
directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`). Unknown model ids
produce a Session error rather than silently running a different model.

`deploy/pi-models.json` contains the managed model definitions. Provider keys
are environment-variable references; actual values belong in the Host Secret.
Install it as the Host's Pi `models.json`. Turn startup uses the configured
and cached catalogs without initiating a network catalog refresh.

- K3 uses `KIMI_CODING_API_KEY` or the `kimi-coding-plan` credential in Pi's
  `auth.json`, against `https://api.kimi.com/coding/v1`.
- GLM-5.3 uses the Coding Plan key in `BIGMODEL_API_KEY` against
  `https://open.bigmodel.cn/api/coding/paas/v4`. It supports text input, a 1M-token
  context, and 128K output. Thinking stays enabled and tool history retains
  reasoning content (`thinkingFormat: zai`).
- DeepSeek V4.1 Flash uses `DEEPSEEK_API_KEY` against
  `https://api.deepseek.com`, with model ID `deepseek-flash`. It supports text
  and image input, a 1M-token context, and 384K output. Tool history retains
  reasoning content (`thinkingFormat: deepseek`).
- Astra and Sol use the `openai-codex` OAuth credential in Pi's `auth.json`,
  against `https://chatgpt.com/backend-api`.

The Host needs these model credentials; the tool Sandbox does not need them.
Keep actual credentials out of images and version control. Existing Host Pi
volumes must receive the model definitions as well as updated SDK code.

## Production configuration

Production mounts `oma-infra/oma-pi-gateway` at `/opt/pi-agent-seed`, including
`models.json` and `auth.json`. Merge catalog changes into that Secret while
preserving unrelated providers and credentials. The three API keys are stored
in the Secret's model definitions; the checked-in environment references are
for other deployment environments. These credentials are Host-only.

K3 now uses Kimi's official endpoint directly. Replace the old Ark definition
under `kimi-coding-plan` rather than creating another selection; existing
Agents using `kimi-coding-plan/k3` retain their selection. The upstream model ID
is `k3`, not Ark's `kimi-k3`. Secret subPath mounts require a Host rollout to
load changed configuration.

The console creates Agents with the default Sandbox template and no image
override. Production currently sets `SANDBOX_TEMPLATE=auto-story-v2`. Saving
an Agent with the retired `auto-story` option removes that override; existing
custom templates and Sandbox environment variables are preserved.

## Model metadata (verified 2026-09-15)

GLM-5.3 is BigModel's flagship. DeepSeek's current recommended model is
V4.1 Flash, whose official release reports stronger performance than V4 Pro.
Kimi K3's available context was confirmed as 1,048,576 tokens through the
provided account's model catalog; its output limit remains a conservative
32,768 tokens. Pi supports text/image inputs here, so video is not advertised.

BigModel uses the Coding Plan subscription route. Its token-cost estimate is
omitted (Pi falls back to zero, which does not mean unlimited quota). The same
key had no pay-as-you-go balance, so the general API endpoint was not used.
DeepSeek's static USD estimate uses peak rates; actual off-peak charges are
half of these. Kimi's zero token-cost metadata represents its
subscription route, not unlimited quota.

Official sources: [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3),
[BigModel Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/latest-model),
[BigModel Pi integration](https://docs.bigmodel.cn/cn/coding-plan/tool/others),
[Kimi Code models](https://www.kimi.com/code/docs/kimi-code/models.html),
[DeepSeek pricing and limits](https://api-docs.deepseek.com/quick_start/pricing/),
[DeepSeek V4.1 Flash release](https://api-docs.deepseek.com/news/news260910/).

## User-owned providers

The console's **Models** page configures Tenant-owned providers. Choose OpenAI
Chat Completions (`openai-completions`), OpenAI Responses (`openai-responses`), or
Anthropic Messages (`anthropic-messages`), enter a public HTTPS Base URL and API
key, then click **Fetch models**. The searchable list contains only models
returned by that endpoint using those credentials. Select up to ten models.
Changing the endpoint, protocol or API key clears fetched results and selections;
refreshing the list drops selected IDs no longer returned. Fetch failures and
empty lists are shown explicitly, without a built-in catalog fallback. For
services without a model-list API, manual IDs remain an explicit fallback.
Review context/output limits and reasoning/image capabilities: endpoint metadata
is used when available, otherwise conservative defaults apply.

**Test selected models** makes one small inference request for every selected
model using Pi. It may incur provider charges. A test proves that these inference
requests work, not that every tool, image or reasoning feature is supported.
Only a successful test permits saving; changing any configuration or waiting
more than fifteen minutes requires another test. Saved keys are never returned
to the browser; a blank key during an edit retains the stored key.

Both probes and Agent Turns use Pi 0.83.0's public `createProvider`, native
protocol API implementations, credential handling, and `completeSimple`/stream
methods. The Host injects only transport restrictions and Tenant-scoped state;
there is no application implementation of protocol payloads or stream parsing.
Only the selected provider is registered into the Turn-local `ModelRuntime`.
An Agent's model reference is `custom-<uuid>/<upstream-model-id>`; the upstream
ID can contain slashes. Deleted providers or models fail explicitly on the next
Turn. Built-in selections continue to use the Host's Pi configuration.

Discovery uses Pi's `createProvider({ fetchModels })` and `Models.refresh()`.
The callback delegates model listing, authentication headers and pagination to
the official OpenAI/Anthropic SDKs already used by this Pi version. OpenAI
protocols call `<Base URL>/models`; Anthropic calls `<Base URL>/v1/models`.
Discovery does not run inference or prove a returned model can complete a Turn;
the separate Pi inference test remains required. Each discovery has a 30-second
deadline, bounded response size and model/page counts, and an isolated in-memory
Pi catalog. No endpoint list is substituted from Pi's bundled catalog.

Protocols requiring OAuth, cloud identities, deployment-specific credentials or
a custom transport are not offered by this API-key form. The current three protocols
support Pi's injectable fetch, which lets Host enforce public-address DNS
resolution at socket connection time, reject redirects and avoid credential
leaks in upstream error bodies. Custom-provider requests use a dedicated direct
HTTPS dispatcher, independent of the global `OMA_PROXY_URL`; the deployment must
permit direct HTTPS egress to these endpoints.

For local development with a proxy in Fake-IP mode, exclude provider domains
from Fake-IP DNS (for example, add `open.bigmodel.cn` to Clash/Mihomo's
`dns.fake-ip-filter`). Reserved `198.18.0.0/15` addresses are deliberately blocked,
even when the proxy would route them to a public service. Discovery and inference tests report
this DNS failure separately from authentication errors; no API key reaches the
provider when the connection is blocked.

Inference tests also report the upstream HTTP status without exposing upstream
error bodies. A 404/405 can mean the selected protocol's inference endpoint is
unsupported even when model discovery succeeds: OpenAI Chat Completions and
OpenAI Responses share `/models` but call `/chat/completions` and `/responses`,
respectively. Live production probes on 2026-09-24 confirmed that BigModel's
Coding endpoint accepted Chat Completions for `glm-5.3` but returned 404 for
Responses. A 401/403 points to credentials/access; a 429 to rate limits/quota.
These signals help diagnose a failed test; a generic error from an older release
alone cannot identify which condition occurred.

### Deployment

Apply `deploy/migrations/0016_model_providers.sql` before deploying the Host
when `PG_ENSURE_SCHEMA=false`. Configure `OMA_PROVIDER_ENCRYPTION_KEY` as a
stable random 32-byte key encoded in 64 hex characters in `oma-secrets`. The
manifest mounts it only on Host. Back up the key with the database; changing or
losing it makes stored provider credentials unreadable. Key rotation needs an
explicit decrypt/re-encrypt migration. Never put its value in version control.
The memory development server creates a process-local key for its ephemeral store.

Without this key, provider writes/tests return a configuration error; existing
managed models remain usable. Credentials use AES-256-GCM with Tenant/provider
identity as authenticated data. A test proof is also encrypted, Tenant-bound,
and tied to the entire tested configuration. API list/get responses contain
metadata only. No credentials are written to Agents, Workspace/Sandbox files,
Host `models.json`, or Host `auth.json`.

API operations are documented in `docs/openapi.json` under **Model Providers**:
list/save at `/v1/model-providers`, protocol choices at `/v1/model-providers/protocols`,
endpoint discovery at `/v1/model-providers/discover`, probe at
`/v1/model-providers/test`, and delete at `/v1/model-providers/{id}`.
