import { OpenAPIHono } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Env, Handler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RegisteredOpenApiRoute } from "./routes.js";

/**
 * Runtime router used by route factories whose method/path registration is
 * also their OpenAPI source of truth.
 */
export function createContractRouter<E extends Env>(): OpenAPIHono<E> {
  const router = new OpenAPIHono<E>({
    defaultHook(result, c) {
      if (!result.success) {
        const error = result.error.issues[0]?.message ??
          "Request does not match the API contract";
        return c.json(
          { error, code: "validation_error" },
          400,
        );
      }
    },
  });
  router.onError((error, c) => {
    if (
      error instanceof HTTPException &&
      error.status === 400 &&
      error.message === "Malformed JSON in request body"
    ) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (error instanceof HTTPException) return error.getResponse();
    return c.json({ error: "Internal Server Error" }, 500);
  });
  return router;
}

/**
 * Bind one contract to both Hono and the local OpenAPI registry. Hono executes
 * the same Zod request schemas that are emitted to OpenAPI, so a documented
 * request shape cannot silently diverge from runtime behavior.
 */
export function registerContractRoute<E extends Env>(
  router: OpenAPIHono<E>,
  route: RegisteredOpenApiRoute,
  handler: Handler<E, string>,
  options: { runtimePath?: string } = {},
): void {
  if (!options.runtimePath) {
    router.openapi(route, handler as RouteHandler<RouteConfig, E>);
    return;
  }

  // OpenAPI path parameters cannot express Hono's greedy wildcard syntax.
  // Register the public contract unchanged, then validate/serve an equivalent
  // hidden route whose runtime path captures the entire remaining file path.
  router.openAPIRegistry.registerPath(route);
  router.openapi(
    {
      ...route,
      path: options.runtimePath,
      hide: true,
    } as RouteConfig,
    handler as RouteHandler<RouteConfig, E>,
  );
}
