import OSS from "ali-oss";
import type { Artifact, ArtifactContent, ArtifactPutInput, ArtifactStore } from "../interfaces/artifact-store.js";
import { validateArtifactPath, workspaceObjectPrefix } from "../workspace-path.js";
import { resolveArtifactContentType } from "../artifact-content-type.js";

function isMissingObject(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "NoSuchKey";
}

function contentTypeFromHeaders(headers: object): string | undefined {
  const value: unknown = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
  return typeof value === "string" ? value : undefined;
}

/** The official SDK boundary; injected clients allow repeatable storage tests. */
export interface OSSObjectClient {
  put(name: string, body: Buffer, options?: { mime?: string }): Promise<unknown>;
  get(name: string): Promise<{ content?: Buffer; res: { headers: object } }>;
  head(name: string): Promise<{ res: { headers: object } }>;
  delete(name: string): Promise<unknown>;
  listV2(query: { prefix: string; "max-keys": number; "continuation-token"?: string }): Promise<{
    objects?: Array<{ name: string; size: number; lastModified?: string }>;
    isTruncated: boolean;
    nextContinuationToken?: string | null;
  }>;
}

export interface OSSArtifactStoreOptions {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  /** Host endpoint may use the Alibaba private network. */
  endpoint?: string;
  /** Public regional HTTPS endpoint used only for browser GET signatures. */
  publicEndpoint?: string;
  refreshSTSToken?: OSS.Options["refreshSTSToken"];
  /** Override only the external SDK boundary, e.g. a repeatable integration fixture. */
  client?: OSSObjectClient;
}

export class OSSArtifactStore implements ArtifactStore {
  private readonly client: OSSObjectClient;
  private readonly signer: OSS;

  constructor(options: OSSArtifactStoreOptions) {
    const { client, publicEndpoint, ...sdkOptions } = options;
    if (!/^oss-[a-z0-9-]+$/.test(options.region) || options.region.includes("-internal")) {
      throw new Error("Invalid OSS region");
    }
    const expectedPublicEndpoint = `https://${options.region}.aliyuncs.com`;
    if (publicEndpoint && publicEndpoint.replace(/\/$/, "") !== expectedPublicEndpoint) {
      throw new Error("Browser downloads require the public OSS endpoint for the configured region over HTTPS");
    }
    this.client = client ?? new OSS({ ...sdkOptions, secure: true, authorizationV4: true });
    this.signer = new OSS({ ...sdkOptions, endpoint: expectedPublicEndpoint, secure: true, authorizationV4: true });
  }

  private key(tenantId: string, workspaceId: string, path: string): string {
    const key = workspaceObjectPrefix(tenantId, workspaceId) + validateArtifactPath(path);
    if (Buffer.byteLength(key) > 1023) throw new Error("Invalid artifact path: OSS key exceeds 1023 bytes");
    return key;
  }

  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body = Buffer.from(input.body);
    await this.client.put(this.key(input.tenantId, input.workspaceId, input.path), body, { mime: resolveArtifactContentType(input.path, input.contentType) });
    return { path: input.path, size: body.length };
  }

  async get(tenantId: string, workspaceId: string, path: string): Promise<ArtifactContent | null> {
    const key = this.key(tenantId, workspaceId, path);
    try {
      const object = await this.client.get(key);
      if (!object.content) throw new Error("OSS returned no object body");
      return { path, body: new Uint8Array(object.content), contentType: resolveArtifactContentType(path, contentTypeFromHeaders(object.res.headers)) };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    const root = workspaceObjectPrefix(tenantId, workspaceId);
    const searchPrefix = prefix ? this.key(tenantId, workspaceId, prefix.replace(/\/$/, "")) + "/" : root;
    const artifacts: Artifact[] = [];
    let token: string | undefined;
    const seenTokens = new Set<string>();
    do {
      const page = await this.client.listV2({ prefix: searchPrefix, "max-keys": 1000, ...(token ? { "continuation-token": token } : {}) });
      for (const object of page.objects ?? []) {
        if (!object.name.startsWith(searchPrefix)) throw new Error("OSS listing returned an object outside the Workspace prefix");
        const path = object.name.slice(root.length);
        if (object.name.endsWith("/") || path.split("/")[0] === ".oma-workspace-checks") continue;
        artifacts.push({ path, size: object.size, updatedAt: object.lastModified ? new Date(object.lastModified) : undefined });
      }
      if (!page.isTruncated) break;
      if (!page.nextContinuationToken || seenTokens.has(page.nextContinuationToken)) {
        throw new Error("OSS listing returned an invalid continuation token");
      }
      token = page.nextContinuationToken;
      seenTokens.add(token);
    } while (true);
    return artifacts;
  }

  async exists(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    const key = this.key(tenantId, workspaceId, path);
    try {
      await this.client.head(key);
      return true;
    } catch (error) {
      if (isMissingObject(error)) return false;
      throw error;
    }
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    const key = this.key(tenantId, workspaceId, path);
    if (!await this.exists(tenantId, workspaceId, path)) return false;
    await this.client.delete(key);
    return true;
  }

  async createSignedReadUrl(tenantId: string, workspaceId: string, path: string, expiresInSec: number): Promise<string> {
    const key = this.key(tenantId, workspaceId, path);
    if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 900) {
      throw new Error("OSS read URL expiry must be an integer between 1 and 900 seconds");
    }
    const metadata = await this.client.head(key);
    return this.signer.signatureUrlV4("GET", expiresInSec, {
      queries: { "response-content-type": resolveArtifactContentType(path, contentTypeFromHeaders(metadata.res.headers)) },
    }, key);
  }

  /** Verify the mount's actual object destination after the probe is closed
   * and before cleanup. This private subtree is never a business file. */
  async verifyWorkspaceProbe(prefix: string, probeName: string, expectedContent: string): Promise<void> {
    const parts = prefix.split("/");
    try {
      if (parts.length !== 3 || prefix !== workspaceObjectPrefix(parts[0], parts[1]) || !/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(probeName)) {
        throw new Error("Invalid Workspace probe");
      }
    } catch {
      throw new Error("Invalid Workspace probe");
    }
    try {
      const object = await this.client.get(`${prefix}.oma-workspace-checks/${probeName}`);
      if (!object.content?.equals(Buffer.from(expectedContent))) throw new Error("Probe mismatch");
    } catch {
      // SDK failures can carry signed request details; keep them out of Turn events.
      throw new Error("Workspace mount verification failed");
    }
  }
}
