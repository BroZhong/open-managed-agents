import type { Api, Model } from "@earendil-works/pi-ai";

/** Let Pi emit its explicit strict:false default for Responses function tools. */
export function withResponsesToolCompat(model: Model<Api>): Model<Api> {
  if (model.api !== "openai-responses") return model;
  // This flag enables serialization of the strict field, not strict validation.
  // Omitting it lets Responses normalize optional schema fields into required ones.
  return { ...model, compat: { ...model.compat, supportsStrictMode: true } };
}
