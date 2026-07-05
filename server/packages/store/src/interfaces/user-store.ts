import type { User } from "../types.js";

export interface UserStoreCreateInput {
  username: string;
  passwordHash: string;
  tenantId: string;
}

export interface UserStore {
  create(input: UserStoreCreateInput): Promise<User>;
  /** Case-insensitive lookup by username. */
  findByUsername(username: string): Promise<User | null>;
}
