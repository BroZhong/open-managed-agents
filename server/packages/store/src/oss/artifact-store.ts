import OSS from "ali-oss";
import { isIP } from "node:net";
import type { Artifact, ArtifactContent, ArtifactMetadata, ArtifactPutInput, ArtifactReadUrlOptions, ArtifactStore } from "../interfaces/artifact-store.js";
import { validateArtifactPath, workspaceObjectPrefix } from "../workspace-path.js";
import { resolveArtifactContentType } from "../artifact-content-type.js";

function isMissingObject(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "NoSuchKey";
}

function headerValue(headers: object, header: string): string | undefined {
  const value: unknown = Object.entries(headers).find(([name]) => name.toLowerCase() === header)?.[1];
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : undefined;
}

function attachmentDisposition(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"` +
    (fallback !== filename ? `; filename*=UTF-8''${encoded}` : "");
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
  /** Public regional HTTPS endpoint, or an HTTPS custom domain bound to this
   * Bucket. Custom domains support inline preview and MIME response overrides. */
  publicEndpoint?: string;
  refreshSTSToken?: OSS.Options["refreshSTSToken"];
  /** Override only the external SDK boundary, e.g. a repeatable integration fixture. */
  client?: OSSObjectClient;
}

export class OSSArtifactStore implements ArtifactStore {
  private readonly client: OSSObjectClient;
  private readonly signer: OSS;
  private readonly usesCustomDomain: boolean;

  constructor(options: OSSArtifactStoreOptions) {
    const { client, publicEndpoint, ...sdkOptions } = options;
    if (!/^oss-[a-z0-9-]+$/.test(options.region) || options.region.includes("-internal")) {
      throw new Error("Invalid OSS region");
    }
    const expectedPublicEndpoint = `https://${options.region}.aliyuncs.com`;
    let publicUrl: URL;
    try {
      publicUrl = new URL(publicEndpoint ?? expectedPublicEndpoint);
    } catch {
      throw new Error("Invalid public OSS endpoint");
    }
    this.usesCustomDomain = publicUrl.origin !== expectedPublicEndpoint;
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.port ||
      publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash ||
      (this.usesCustomDomain && (isIP(publicUrl.hostname) || !publicUrl.hostname.includes(".") ||
        /(?:^|\.)(?:aliyuncs\.com|localhost|local|internal)$/.test(publicUrl.hostname)))) {
      throw new Error("The public OSS endpoint must be the regional HTTPS endpoint or a public HTTPS custom domain bound to the Bucket");
    }
    this.client = client ?? new OSS({ ...sdkOptions, secure: true, authorizationV4: true });
    this.signer = new OSS({ ...sdkOptions, endpoint: publicUrl.origin, cname: this.usesCustomDomain, secure: true, authorizationV4: true });
  }

  private key(tenantId: string, workspaceId: string, path: string): string {
    const key = workspaceObjectPrefix(tenantId, workspaceId) + validateArtifactPath(path);
    if (Buffer.byteLength(key) > 1023) throw new Error("Invalid artifact path: OSS key exceeds 1023 bytes");
    return key;
  }

  private async headObject(key: string): ReturnType<OSSObjectClient["head"]> {
    try {
      return await this.client.head(key);
    } catch (error) {
      if (!isMissingObject(error)) throw error;
      // OSS HEAD has no XML error body: the SDK maps every 404, including a
      // missing Bucket, to NoSuchKey. A bounded listing disambiguates without
      // downloading bytes and propagates Bucket/permission/service failures.
      const page = await this.client.listV2({ prefix: key, "max-keys": 1 });
      if (page.objects?.some((object) => object.name === key)) {
        return this.client.head(key); // The file was created after the first HEAD.
      }
      throw error;
    }
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
      return { path, body: new Uint8Array(object.content), contentType: resolveArtifactContentType(path, headerValue(object.res.headers, "content-type")) };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async stat(tenantId: string, workspaceId: string, path: string): Promise<ArtifactMetadata | null> {
    try {
      const { res } = await this.headObject(this.key(tenantId, workspaceId, path));
      const length = headerValue(res.headers, "content-length");
      const size = Number(length);
      if (length === undefined || !Number.isSafeInteger(size) || size < 0) {
        throw new Error("OSS returned invalid object size");
      }
      const lastModified = headerValue(res.headers, "last-modified");
      return { path, size,
        contentType: resolveArtifactContentType(path, headerValue(res.headers, "content-type")),
        etag: headerValue(res.headers, "etag"),
        ...(lastModified ? { updatedAt: new Date(lastModified) } : {}),
      };
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
      await this.headObject(key);
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

  async createSignedReadUrl(tenantId: string, workspaceId: string, path: string, expiresInSec: number, options: ArtifactReadUrlOptions = {}): Promise<string> {
    const key = this.key(tenantId, workspaceId, path);
    if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 900) {
      throw new Error("OSS read URL expiry must be an integer between 1 and 900 seconds");
    }
    const queries: Record<string, string> = {};
    if (options.download) queries["response-content-disposition"] = attachmentDisposition(path);
    else if (this.usesCustomDomain) queries["response-content-disposition"] = "inline";
    // Regional OSS endpoints reject MIME overrides (EC0017-00000902).
    // A bound custom domain permits them without rewriting existing objects.
    if (this.usesCustomDomain && options.contentType) {
      if (/[\r\n]/.test(options.contentType)) throw new Error("Invalid object Content-Type");
      queries["response-content-type"] = options.contentType;
    }
    return this.signer.signatureUrlV4("GET", expiresInSec, { queries }, key);
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
