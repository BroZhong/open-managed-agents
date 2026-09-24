import { startHost } from "./bootstrap.js";
void startHost("runner").catch(error => { console.error(error); process.exit(1); });
