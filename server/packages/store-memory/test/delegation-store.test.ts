import { createMemoryStores } from "../src/index.js";
import { delegationContract } from "../../store/test/delegation-contract.js";
delegationContract("Memory delegation lifecycle", async () => createMemoryStores());
