import { InMemoryEnvironmentStore } from "../src/index.js";
import { environmentStoreContract } from "../../store/test/environment-store-contract.js";

environmentStoreContract("InMemoryEnvironmentStore", async () => new InMemoryEnvironmentStore());
