import type { SandboxEnvironments } from "./turn-sandboxes.js";

/** The image a {@link fakeEnvironments} Environment serves unless told otherwise. */
export const FAKE_ENVIRONMENT_IMAGE = "registry.example/welltop/oma-environments@sha256:" + "0".repeat(64);

/** {@link fakeEnvironments}' state, which a test changes between calls to rebuild or edit an Environment. */
export interface FakeEnvironments extends SandboxEnvironments {
  /** Serving images by Environment id; an id not listed serves the fallback image. */
  readonly images: Record<string, string | null>;
  /** Resolved variables by Environment id. */
  readonly values: Record<string, Record<string, string>>;
}

/**
 * In-memory {@link SandboxEnvironments} for tests: every Environment serves
 * its image in `images`, else `image` ({@link FAKE_ENVIRONMENT_IMAGE} unless
 * given), with its variables in `values`, read at each call.
 */
export function fakeEnvironments(options: {
  image?: string | null;
  images?: Record<string, string | null>;
  values?: Record<string, Record<string, string>>;
} = {}): FakeEnvironments {
  const images = options.images ?? {};
  const values = options.values ?? {};
  const fallback = options.image === undefined ? FAKE_ENVIRONMENT_IMAGE : options.image;
  return {
    images, values,
    image: async (_tenantId, id) => (Object.hasOwn(images, id) ? images[id]! : fallback),
    variables: async (_tenantId, id) => ({ ...values[id] }),
  };
}
