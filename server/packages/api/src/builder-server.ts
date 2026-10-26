import { startImageBuilder } from "./image-builder/main.js";
void startImageBuilder().catch(error => { console.error(error); process.exit(1); });
