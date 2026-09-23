import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type {
  ModelProviderStore,
  ModelProviderRecord,
  SessionStore,
} from "@oma-server/store";
import type {
  discoverCustomProviderModels,
  testCustomProvider,
  CustomProviderDefinition,
  PiAgentAdapterOptions,
} from "@open-managed-agents/adapter-pi-agent";
import {
  providerAddressError,
  providerBaseUrl,
  providerFetch,
} from "./provider-fetch.js";

class ProviderError extends HTTPException {
  constructor(status: 400 | 404 | 422 | 503, options: { message: string }) {
    super(status, {
      res: Response.json({ error: options.message }, { status }),
    });
  }
}

export type ProviderInput = Omit<CustomProviderDefinition, "id" | "apiKey"> & {
  id?: string;
  apiKey?: string;
};
export function publicProvider(record: ModelProviderRecord) {
  const { encryptedApiKey: _key, tenantId: _tenant, ...metadata } = record;
  return { ...metadata, hasApiKey: true };
}
export class ModelProviderService {
  constructor(
    readonly store: ModelProviderStore,
    private readonly encryptionKey: string | undefined,
    private readonly probe: typeof testCustomProvider = async (...args) => (await import("@open-managed-agents/adapter-pi-agent")).testCustomProvider(...args),
    private readonly discoverModels: typeof discoverCustomProviderModels = async (...args) => (await import("@open-managed-agents/adapter-pi-agent")).discoverCustomProviderModels(...args),
  ) {}
  private key() {
    if (!this.encryptionKey || !/^[a-f\d]{64}$/i.test(this.encryptionKey)) {
      throw new ProviderError(503, {
        message:
          "Model provider storage requires OMA_PROVIDER_ENCRYPTION_KEY (32 bytes encoded as hex).",
      });
    }
    return Buffer.from(this.encryptionKey, "hex");
  }
  private seal(value: string, scope: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(scope));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64url",
    );
  }
  private open(value: string, scope: string) {
    const bytes = Buffer.from(value, "base64url");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      bytes.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
  private async definition(
    tenantId: string,
    input: ProviderInput,
  ): Promise<CustomProviderDefinition> {
    this.key();
    const existing = input.id ? await this.store.get(tenantId, input.id) : null;
    if (input.id && !existing)
      throw new ProviderError(404, { message: "Provider not found" });
    const apiKey =
      input.apiKey ||
      (existing
        ? this.open(existing.encryptedApiKey, `${tenantId}:${existing.id}`)
        : "");
    if (!apiKey)
      throw new ProviderError(400, { message: "API key is required" });
    let baseUrl: string;
    try {
      baseUrl = providerBaseUrl(input.baseUrl);
    } catch {
      throw new ProviderError(400, {
        message:
          "Use a public HTTPS provider URL without credentials, query parameters or fragments.",
      });
    }
    return {
      id: existing?.id ?? "custom-probe",
      name: input.name,
      api: input.api,
      baseUrl,
      apiKey,
      models: input.models,
    };
  }
  private fingerprint(definition: CustomProviderDefinition) {
    return createHash("sha256")
      .update(JSON.stringify(definition))
      .digest("hex");
  }
  async discover(
    tenantId: string,
    input: Pick<ProviderInput, "id" | "api" | "baseUrl" | "apiKey">,
  ) {
    const definition = await this.definition(tenantId, {
      ...input,
      name: "Model discovery",
      models: [],
    });
    try {
      const data = await this.discoverModels(
        definition,
        providerFetch(definition.baseUrl),
      );
      return { data };
    } catch (error) {
      const { ModelDiscoveryError } = await import("@open-managed-agents/adapter-pi-agent");
      throw new ProviderError(422, {
        message:
          providerAddressError(error)?.message ??
          (error instanceof ModelDiscoveryError
            ? error.message
            : "Could not fetch models from this endpoint. Check the Base URL, protocol and API key."),
      });
    }
  }
  async test(tenantId: string, input: ProviderInput) {
    const definition = await this.definition(tenantId, input);
    try {
      await this.probe(definition, providerFetch(definition.baseUrl));
    } catch (error) {
      // Only our SDK helper's fixed message is safe to expose.
      const message =
        error instanceof Error &&
        definition.models.some(
          (model) =>
            error.message ===
            `Model ${model.id} did not complete a test request. Check the protocol, URL, API key and model access.`,
        )
          ? error.message
          : "Provider test failed. Check the endpoint, protocol, API key and model access.";
      throw new ProviderError(422, { message });
    }
    const testedAt = new Date().toISOString();
    return {
      testedAt,
      verificationToken: this.seal(
        JSON.stringify({
          fingerprint: this.fingerprint(definition),
          testedAt,
          expires: Date.now() + 15 * 60_000,
        }),
        `verification:${tenantId}`,
      ),
    };
  }
  async save(
    tenantId: string,
    input: ProviderInput,
    verificationToken: string,
  ) {
    const definition = await this.definition(tenantId, input);
    let testedAt: string;
    try {
      const proof = JSON.parse(
        this.open(verificationToken, `verification:${tenantId}`),
      );
      if (
        proof.expires < Date.now() ||
        proof.fingerprint !== this.fingerprint(definition)
      )
        throw new Error("stale");
      testedAt = proof.testedAt;
    } catch {
      throw new ProviderError(400, {
        message:
          "Configuration changed or test expired. Test the selected models again before saving.",
      });
    }
    const { apiKey, ...config } = definition;
    const id = input.id ?? `custom-${randomUUID()}`;
    const record: ModelProviderRecord = {
      ...config,
      id,
      tenantId,
      testedAt,
      encryptedApiKey: this.seal(apiKey, `${tenantId}:${id}`),
    };
    await this.store.save(record);
    return publicProvider(record);
  }
  configureRuntime(
    sessions: SessionStore,
  ): NonNullable<PiAgentAdapterOptions["configureModelRuntime"]> {
    return async (input, runtime) => {
      const providerId = input.agent.model.split("/")[0];
      if (!providerId.startsWith("custom-")) return;
      const session = await sessions.getById(input.sessionId);
      const record =
        session && (await this.store.get(session.tenantId, providerId));
      if (!record)
        throw new Error(
          "Custom model provider is unavailable for this Tenant.",
        );
      const {
        encryptedApiKey,
        tenantId,
        testedAt: _testedAt,
        ...config
      } = record;
      const { registerCustomProvider } = await import("@open-managed-agents/adapter-pi-agent");
      await registerCustomProvider(
        runtime,
        {
          ...config,
          apiKey: this.open(encryptedApiKey, `${tenantId}:${record.id}`),
        },
        providerFetch(record.baseUrl),
      );
    };
  }
}
