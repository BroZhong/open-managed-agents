import { realpathSync } from "node:fs";
// Local executor child processes load the same unmodified SDK as the reference.
process.env.OMA_PI_TOOL_MODULE = realpathSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url));
