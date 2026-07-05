import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { UserStore } from "@oma-server/store";
import { isAuthConfigured, signSessionToken } from "../auth/tokens.js";

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const BCRYPT_ROUNDS = 10;

export function authRoutes(userStore: UserStore) {
  const router = new Hono();

  // POST /auth/register — create an account and auto-login.
  router.post("/auth/register", async (c) => {
    // (1) auth secret present
    if (!isAuthConfigured()) {
      return c.json({ error: "auth unavailable", code: "auth_unavailable" }, 503);
    }

    const body = await c.req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const inviteCode = typeof body?.inviteCode === "string" ? body.inviteCode : "";

    // (2) INVITE_CODE configured
    const expectedInvite = process.env.INVITE_CODE;
    if (!expectedInvite) {
      return c.json(
        { error: "registration not open", code: "registration_closed" },
        403,
      );
    }

    // (3) invite code matches — before touching username
    if (inviteCode !== expectedInvite) {
      return c.json(
        { error: "invite code invalid", code: "invalid_invite_code" },
        403,
      );
    }

    // (4) username/password format valid
    if (!USERNAME_RE.test(username)) {
      return c.json(
        {
          error:
            "username must be 3-32 chars (letters, digits, underscore, hyphen)",
          code: "validation_error",
        },
        400,
      );
    }
    if (password.length < 8) {
      return c.json(
        { error: "password must be at least 8 characters", code: "validation_error" },
        400,
      );
    }

    // (5) username availability
    const existing = await userStore.findByUsername(username);
    if (existing) {
      return c.json({ error: "username taken", code: "username_taken" }, 409);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const tenantId = randomUUID();
    const user = await userStore.create({ username, passwordHash, tenantId });

    const token = await signSessionToken(user.tenantId);
    return c.json({ token }, 200);
  });

  // POST /auth/login — verify credentials and issue a session token.
  router.post("/auth/login", async (c) => {
    if (!isAuthConfigured()) {
      return c.json({ error: "auth unavailable", code: "auth_unavailable" }, 503);
    }

    const body = await c.req.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";

    const user = await userStore.findByUsername(username);
    if (!user) {
      return c.json({ error: "invalid credentials", code: "invalid_credentials" }, 401);
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return c.json({ error: "invalid credentials", code: "invalid_credentials" }, 401);
    }

    const token = await signSessionToken(user.tenantId);
    return c.json({ token }, 200);
  });

  return router;
}
