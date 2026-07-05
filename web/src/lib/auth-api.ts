import { BASE_URL } from "./api";

/**
 * Error thrown by the auth endpoints. Carries both the human `message`
 * (from the backend `error` field) and the machine `code`, so callers can
 * decide which form field to attach the error to (e.g. `invalid_invite_code`
 * → invite field, `username_taken` → username field).
 *
 * These calls intentionally bypass `apiFetch`, whose global 401 handler
 * redirects to /login — which would fight the login/register pages.
 */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

interface AuthSuccess {
  token: string;
}

async function postAuth(
  path: string,
  body: Record<string, string>,
): Promise<AuthSuccess> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("network_error", "Cannot reach server", 0);
  }

  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    code?: string;
  };

  if (!response.ok) {
    throw new AuthError(
      data.code ?? "unknown_error",
      data.error ?? `Request failed with status ${response.status}`,
      response.status,
    );
  }

  if (!data.token) {
    throw new AuthError("unknown_error", "Malformed response from server", response.status);
  }

  return { token: data.token };
}

export function authLogin(input: {
  username: string;
  password: string;
}): Promise<AuthSuccess> {
  return postAuth("/auth/login", input);
}

export function authRegister(input: {
  username: string;
  password: string;
  inviteCode: string;
}): Promise<AuthSuccess> {
  return postAuth("/auth/register", input);
}
