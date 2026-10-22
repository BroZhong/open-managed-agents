import { InMemorySkillBundleStore } from "../src/index.js";
import { skillBundleStoreContract } from "../../store/test/skill-bundle-store-contract.js";

skillBundleStoreContract("InMemorySkillBundleStore", async () => ({
  store: new InMemorySkillBundleStore(),
  async download(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Install download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
}));
