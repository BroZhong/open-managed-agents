import OSS from "ali-oss";
import type { EventPayloadStore } from "../event-payload.js";
import type { OSSArtifactStoreOptions, OSSObjectClient } from "./artifact-store.js";

/** Host-only immutable results; deliberately outside every mounted Workspace. */
export class OSSEventPayloadStore implements EventPayloadStore {
  private readonly client: Pick<OSSObjectClient, "put" | "get">;
  constructor(options: OSSArtifactStoreOptions) {
    const { client, publicEndpoint: _publicEndpoint, ...sdkOptions } = options;
    this.client = client ?? new OSS({ ...sdkOptions, secure: true, authorizationV4: true });
  }
  private key(sessionId: string, sha256: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid Session result identity");
    return `__oma/session-results/v1/${sessionId}/${sha256}.json`;
  }
  async put(sessionId: string, sha256: string, body: Buffer): Promise<void> {
    // Content-addressed writes are idempotent. Never overwrite from a mutable path.
    await this.client.put(this.key(sessionId, sha256), body, { mime: "application/json" });
  }
  async get(sessionId: string, sha256: string): Promise<Buffer> {
    const result = await this.client.get(this.key(sessionId, sha256));
    if (!result.content) throw new Error("Session result object is missing");
    return result.content;
  }
}
