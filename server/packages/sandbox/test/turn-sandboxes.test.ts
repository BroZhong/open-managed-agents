import { createMemoryStores } from "@oma-server/store-memory";
import { turnSandboxesContract } from "./turn-sandboxes-contract.js";

turnSandboxesContract("Turn Sandboxes over the in-memory stores", async () => createMemoryStores());
