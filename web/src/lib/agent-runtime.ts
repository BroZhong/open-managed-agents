// Agent runtime/model lock (issue #69).
//
// The current deployment only supports the `pi-agent` runtime and a single
// model. The agent create/edit form must not offer anything else, so the
// runtime and model are fixed here rather than chosen in the UI. This is a
// frontend-only constraint: the backend contract is unchanged, the form just
// always sends these values.

/** The only runtime the current deployment supports. */
export const LOCKED_RUNTIME = "pi-agent";

/**
 * The only model the current deployment supports. Verified present in the
 * pi-ai model catalog (openai-codex provider, gpt-5.5).
 */
export const LOCKED_MODEL = "openai-codex/gpt-5.5";

/** Human-readable label for {@link LOCKED_MODEL}, shown in the locked select. */
export const LOCKED_MODEL_LABEL = "GPT 5.5 (Codex)";
