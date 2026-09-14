# Pi model selection

Pi Agents can select these model ids in the console or the Agent API:

| Model | Agent `model` | Default Pi thinking | Provider effort |
| --- | --- | --- | --- |
| K3 | `kimi-coding-plan/k3` | `xhigh` | `max` |
| GPT-6 Astra | `openai-codex/gpt-6-astra` | `max` | `max` |
| GPT-5.6 Sol | `openai-codex/gpt-5.6-sol` | `max` | `max` |

New Agents default to GPT-5.6 Sol, matching the local Pi model selection.
Editing an existing Agent preserves its model until another model is selected.
The runtime always selects the highest thinking level supported by that model,
including for the managed Storyboard Stage subagent when no explicit subagent
thinking override is supplied.

The Host uses Pi SDK 0.80.10, matching the local Pi installation. Earlier 0.80.3
releases cannot express the `max` thinking level. Each Turn creates one Pi
`ModelRuntime` that both resolves the model and authenticates its requests.
Custom providers and model overrides are loaded from the Host Pi agent
directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`). Unknown model ids
produce a Session error rather than silently running a different model.

`deploy/pi-models.json` contains the three definitions copied from local
`models.json` and `models-store.json`, with only the Kimi environment variable
name retained. Install it as the Host's Pi `models.json`. Turn startup uses the
configured and cached catalogs without initiating a network catalog refresh.

- K3 uses `KIMI_CODING_API_KEY` or the `kimi-coding-plan` credential in Pi's
  `auth.json`, against `https://api.kimi.com/coding/v1`.
- Astra and Sol use the `openai-codex` OAuth credential in Pi's `auth.json`,
  against `https://chatgpt.com/backend-api`.

The Host needs these model credentials; the tool Sandbox does not need them.
Keep actual credentials out of images and version control. Existing Host Pi
volumes must receive the model definitions as well as updated SDK code.
