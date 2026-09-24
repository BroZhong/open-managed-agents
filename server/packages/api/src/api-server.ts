import { startHost } from "./bootstrap.js";
void startHost("api").catch(error => { console.error(error); process.exit(1); });
