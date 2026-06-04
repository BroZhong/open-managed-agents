import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import type { ApiKeyStore } from "./types.js";

// Placeholder store — will be replaced by a real implementation later
const placeholderStore: ApiKeyStore = {
  async findByKeyHash() {
    return null;
  },
};

const app = createApp({ apiKeyStore: placeholderStore });

const port = parseInt(process.env.PORT || "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`);
});
