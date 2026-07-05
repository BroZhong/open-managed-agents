import { nanoid } from "nanoid";
import type { Pool } from "./connection.js";
import type { UserStore, UserStoreCreateInput } from "../interfaces/user-store.js";
import type { User } from "../types.js";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  tenant_id: string;
  created_at: Date;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    tenantId: row.tenant_id,
    createdAt: new Date(row.created_at),
  };
}

export class PgUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async create(input: UserStoreCreateInput): Promise<User> {
    const id = `user_${nanoid()}`;
    const now = new Date();

    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (id, username, password_hash, tenant_id, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.username, input.passwordHash, input.tenantId, now],
    );
    return rowToUser(rows[0]);
  }

  async findByUsername(username: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT * FROM users WHERE lower(username) = lower($1)`,
      [username],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }
}
