import { CUSTOM_PROVIDER_PROTOCOLS } from "@open-managed-agents/adapter-pi-agent/custom-provider-protocols";
import {
  createContractRouter,
  registerContractRoute,
} from "../openapi/router.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import {
  ProviderInputSchema,
  ProviderDiscoverySchema,
} from "../openapi/model-providers.js";
import {
  ModelProviderService,
  publicProvider,
} from "../lib/model-providers.js";
import type { TenantContext } from "../types.js";

export function modelProviderRoutes(service: ModelProviderService) {
  const app = createContractRouter<{ Variables: { tenant: TenantContext } }>();
  for (const path of ["/v1/model-providers", "/v1/model-providers/*"]) {
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });
  }
  registerContractRoute(app, getOpenApiRoute("listModelProviders"), async (c) =>
    c.json({
      data: (await service.store.list(c.get("tenant").tenantId)).map(
        publicProvider,
      ),
    }),
  );
  registerContractRoute(
    app,
    getOpenApiRoute("getModelProviderProtocols"),
    (c) =>
      c.json({
        protocols: CUSTOM_PROVIDER_PROTOCOLS,
      }),
  );
  registerContractRoute(
    app,
    getOpenApiRoute("discoverModelProviderModels"),
    async (c) => {
      const input = ProviderDiscoverySchema.parse(await c.req.json());
      return c.json(await service.discover(c.get("tenant").tenantId, input));
    },
  );
  registerContractRoute(
    app,
    getOpenApiRoute("testModelProvider"),
    async (c) => {
      const input = ProviderInputSchema.parse(await c.req.json());
      return c.json(await service.test(c.get("tenant").tenantId, input));
    },
  );
  registerContractRoute(
    app,
    getOpenApiRoute("saveModelProvider"),
    async (c) => {
      const raw = await c.req.json();
      return c.json(
        await service.save(
          c.get("tenant").tenantId,
          ProviderInputSchema.parse(raw),
          raw.verificationToken,
        ),
      );
    },
  );
  registerContractRoute(
    app,
    getOpenApiRoute("deleteModelProvider"),
    async (c) => {
      const deleted = await service.store.delete(
        c.get("tenant").tenantId,
        c.req.param("id")!,
      );
      return deleted
        ? c.json({ deleted })
        : c.json({ error: "Provider not found" }, 404);
    },
  );
  return app;
}
