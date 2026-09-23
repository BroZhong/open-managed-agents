// Compatibility entrypoint: API and execution in one process.
import { startHost } from "./bootstrap.js";
void startHost("combined").catch(error => { console.error(error); process.exit(1); });
