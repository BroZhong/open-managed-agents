import { InMemorySkillStore } from "../src/index.js";
import { skillStoreBundleContract } from "../../store/test/skill-store-bundle-contract.js";

skillStoreBundleContract("InMemorySkillStore Skill Bundle columns", async () => new InMemorySkillStore());
