import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM sealing of Tenant credentials under the deployment's
 * `OMA_PROVIDER_ENCRYPTION_KEY` (32 bytes as hex): Model Provider API keys and
 * Environment secrets. `scope` is authenticated data naming what a value
 * belongs to, so a ciphertext copied to another row or Tenant does not open.
 * A sealed value is base64url of IV ‖ tag ‖ ciphertext.
 */
export class SecretBox {
  /** `unavailable` is thrown by every operation while the key is missing or malformed. */
  constructor(
    private readonly hexKey: string | undefined,
    private readonly unavailable: () => Error,
  ) {}

  /** Throw `unavailable()` unless values can be sealed and opened. */
  assertAvailable(): void {
    this.key();
  }

  seal(value: string, scope: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(scope));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  open(sealed: string, scope: string): string {
    const bytes = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }

  private key(): Buffer {
    if (!this.hexKey || !/^[a-f\d]{64}$/i.test(this.hexKey)) throw this.unavailable();
    return Buffer.from(this.hexKey, "hex");
  }
}

/** The UTF-8 byte length of a sealed value, without opening it: GCM keeps the length. */
export function sealedPlaintextBytes(sealed: string): number {
  return Math.max(0, Buffer.from(sealed, "base64url").length - IV_BYTES - TAG_BYTES);
}
