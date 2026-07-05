import type { User, UserStore, UserStoreCreateInput } from "@oma-server/store";

export class InMemoryUserStore implements UserStore {
  private users: User[] = [];
  private nextId = 1;

  async create(input: UserStoreCreateInput): Promise<User> {
    const user: User = {
      id: `user_${this.nextId++}`,
      username: input.username,
      passwordHash: input.passwordHash,
      tenantId: input.tenantId,
      createdAt: new Date(),
    };
    this.users.push(user);
    return user;
  }

  async findByUsername(username: string): Promise<User | null> {
    const lower = username.toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === lower) ?? null;
  }
}
