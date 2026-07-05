import { describe, it, expect, vi, afterEach } from "vitest";
import { authLogin, authRegister, AuthError } from "./auth-api";

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authLogin", () => {
  it("returns the token on success", async () => {
    mockFetch(200, { token: "jwt-abc" });
    await expect(
      authLogin({ username: "u", password: "p" }),
    ).resolves.toEqual({ token: "jwt-abc" });
  });

  it("throws AuthError with code on invalid_credentials", async () => {
    mockFetch(401, { error: "bad creds", code: "invalid_credentials" });
    await expect(
      authLogin({ username: "u", password: "p" }),
    ).rejects.toMatchObject({ code: "invalid_credentials", message: "bad creds" });
  });

  it("does not redirect (never touches window) on 401", async () => {
    // The whole point of bypassing apiFetch: a 401 here must just throw.
    mockFetch(401, { error: "bad creds", code: "invalid_credentials" });
    const err = await authLogin({ username: "u", password: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
  });
});

describe("authRegister", () => {
  it("maps invalid_invite_code", async () => {
    mockFetch(403, { error: "nope", code: "invalid_invite_code" });
    await expect(
      authRegister({ username: "u", password: "p", inviteCode: "x" }),
    ).rejects.toMatchObject({ code: "invalid_invite_code" });
  });

  it("maps username_taken", async () => {
    mockFetch(409, { error: "taken", code: "username_taken" });
    await expect(
      authRegister({ username: "u", password: "p", inviteCode: "x" }),
    ).rejects.toMatchObject({ code: "username_taken" });
  });

  it("maps registration_closed", async () => {
    mockFetch(403, { error: "closed", code: "registration_closed" });
    await expect(
      authRegister({ username: "u", password: "p", inviteCode: "x" }),
    ).rejects.toMatchObject({ code: "registration_closed" });
  });

  it("surfaces a network error as AuthError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const err = await authRegister({
      username: "u",
      password: "p",
      inviteCode: "x",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("network_error");
  });
});
