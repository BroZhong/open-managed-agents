import { getModel } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai/compat";

/**
 * Resolve an `AdapterInput.agent.model` string into a Pi `Model` via the
 * pi-ai builtin catalog.
 *
 * The mapping is intentionally small and best-effort:
 *  - "anthropic/<id>" or "openai/<id>" (explicit "provider/id") are honored.
 *  - "claude-*" / "anthropic*" map to the anthropic provider.
 *  - "gpt-*" / "o1*" / "o3*" / "openai*" map to the openai provider.
 *  - "gemini-*" / "google*" map to the google provider.
 *  - "default" / "" / unknown fall back to {@link DEFAULT_MODEL}.
 *
 * API keys are NOT resolved here — they come from the environment / Pi
 * AuthStorage (~/.pi/agent/auth.json) at request time, exactly as the CLI did.
 *
 * `getModel` is a static catalog lookup; if the id is unknown for the resolved
 * provider it returns undefined and we fall back to the default so a bad model
 * string never crashes the run (it surfaces later as an auth/model error via
 * the session error path if the default is also unusable).
 */

/** Default model when the agent does not specify a usable one. */
export const DEFAULT_MODEL: { provider: string; id: string } = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
};

interface ProviderAndId {
  provider: string;
  id: string;
}

function classify(raw: string): ProviderAndId | undefined {
  const model = raw.trim();
  if (!model || model === "default") return undefined;

  // Explicit "provider/id" form wins.
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  }

  const lower = model.toLowerCase();
  if (lower.startsWith("claude") || lower.startsWith("anthropic")) {
    return { provider: "anthropic", id: model };
  }
  if (
    lower.startsWith("gpt") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("openai")
  ) {
    return { provider: "openai", id: model };
  }
  if (lower.startsWith("gemini") || lower.startsWith("google")) {
    return { provider: "google", id: model };
  }
  // Unknown shape: try anthropic (the default provider) with the raw id.
  return { provider: "anthropic", id: model };
}

/**
 * Resolve a model string to a Pi `Model`, falling back to the default when the
 * requested model cannot be found in the builtin catalog.
 */
export function resolveModel(raw: string | undefined): Model<never> {
  const wanted = classify(raw ?? "");
  if (wanted) {
    const found = getModel(
      wanted.provider as never,
      wanted.id as never,
    ) as Model<never> | undefined;
    if (found) return found;
  }
  return getModel(
    DEFAULT_MODEL.provider as never,
    DEFAULT_MODEL.id as never,
  ) as Model<never>;
}
