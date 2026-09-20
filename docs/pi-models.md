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
