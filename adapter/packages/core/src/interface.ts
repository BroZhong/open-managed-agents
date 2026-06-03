import type { AdapterInput, SessionEvent } from "./types.js";

export interface Adapter {
  run(input: AdapterInput): AsyncIterable<SessionEvent>;
}
