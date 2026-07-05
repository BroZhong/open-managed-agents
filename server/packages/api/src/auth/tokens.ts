import { SignJWT, jwtVerify } from "jose";

/** True when a JWT signing secret is configured (auth is usable). */
export function isAuthConfigured(): boolean {
  return !!process.env.AUTH_JWT_SECRET;
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error("AUTH_JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign a session token (HS256, 30-day expiry) carrying the tenantId.
 * Throws if AUTH_JWT_SECRET is unset.
 */
export async function signSessionToken(tenantId: string): Promise<string> {
  return new SignJWT({ tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey());
}

/**
 * Verify a session token. Returns the tenantId payload on success, or null on
 * any failure (bad signature, expired, malformed, secret unset).
 */
export async function verifySessionToken(
  token: string,
): Promise<{ tenantId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const tenantId = payload.tenantId;
    if (typeof tenantId !== "string" || !tenantId) return null;
    return { tenantId };
  } catch {
    return null;
  }
}
