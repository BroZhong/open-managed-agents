/**
 * Supabase Storage accepts a deliberately small object-key alphabet. Workspace
 * paths are POSIX paths and can contain much more (for example the full-width
 * colon in `第10章：漂亮的流程.md`). Keep that storage constraint behind the
 * ArtifactStore boundary by reversibly encoding only the segments that need it.
 */

const ENCODED_SEGMENT_PREFIX = "__oma_b64url_v1__";

/**
 * Custom object metadata is the authoritative discriminator between a codec
 * key and a pre-codec raw key. The physical prefix alone can never be one: a
 * user is allowed to create a literal filename that happens to look encoded.
 */
export const STORAGE_PATH_CODEC_METADATA = Object.freeze({
  open_managed_agents_path_codec: "base64url-v1",
});

// Mirrors Supabase Storage's object-key allowlist, excluding `/` because this
// expression validates one path segment at a time.
const SUPABASE_SAFE_SEGMENT = /^[A-Za-z0-9_!.*'() &$@=;:+,?-]+$/;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeSegment(segment: string): string {
  if (
    segment === "" ||
    (SUPABASE_SAFE_SEGMENT.test(segment) &&
      !segment.startsWith(ENCODED_SEGMENT_PREFIX))
  ) {
    return segment;
  }
  return ENCODED_SEGMENT_PREFIX + toBase64Url(segment);
}

function decodeSegment(segment: string): { value: string; encoded: boolean } {
  if (!segment.startsWith(ENCODED_SEGMENT_PREFIX)) {
    return { value: segment, encoded: false };
  }

  const payload = segment.slice(ENCODED_SEGMENT_PREFIX.length);
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error(`Invalid encoded storage path segment: ${segment}`);
  }

  try {
    const decoded = fromBase64Url(payload);
    if (
      decoded.includes("/") ||
      decoded.includes("\0") ||
      hasUnpairedSurrogate(decoded)
    ) {
      throw new Error(`Invalid encoded storage path segment: ${segment}`);
    }
    // Buffer's base64 decoder is intentionally permissive. Re-encoding makes
    // this marker canonical and prevents malformed marker-like names changing.
    if (encodeSegment(decoded) !== segment) {
      throw new Error(`Invalid encoded storage path segment: ${segment}`);
    }
    return { value: decoded, encoded: true };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid encoded")) {
      throw error;
    }
    throw new Error(`Invalid encoded storage path segment: ${segment}`);
  }
}

/** Encode a normalized logical Workspace path into a Supabase-safe key path. */
export function encodeStoragePath(path: string): string {
  if (path.includes("\0")) {
    throw new Error("Invalid storage path: NUL byte");
  }
  if (hasUnpairedSurrogate(path)) {
    throw new Error("Invalid storage path: unpaired UTF-16 surrogate");
  }
  return path.split("/").map(encodeSegment).join("/");
}

/**
 * Decode a metadata-confirmed codec key back into its exact logical path.
 * Calling this for an unmarked legacy key is a bug: the marker may be a
 * perfectly literal historical filename.
 */
export function decodeStoragePath(path: string): string {
  let sawEncodedSegment = false;
  const decoded = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(ENCODED_SEGMENT_PREFIX)) return segment;
      const result = decodeSegment(segment);
      sawEncodedSegment ||= result.encoded;
      return result.value;
    })
    .join("/");
  if (!sawEncodedSegment || encodeStoragePath(decoded) !== path) {
    throw new Error(`Invalid encoded storage path: ${path}`);
  }
  return decoded;
}

export interface ClassifiedStoragePath {
  logicalPath: string;
  encoded: boolean;
}

/**
 * Interpret a physical path using object metadata as the sole discriminator.
 * Unknown codec versions are corruption/forward-compatibility errors, not
 * legacy paths: silently treating them as raw would rename a user's file.
 */
export function classifyStoragePath(
  path: string,
  metadata: Record<string, unknown> | null | undefined,
): ClassifiedStoragePath {
  const metadataKey = "open_managed_agents_path_codec";
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, metadataKey)) {
    return { logicalPath: path, encoded: false };
  }
  if (
    metadata[metadataKey] !==
    STORAGE_PATH_CODEC_METADATA.open_managed_agents_path_codec
  ) {
    throw new Error(`Unsupported storage path codec: ${String(metadata[metadataKey])}`);
  }
  return { logicalPath: decodeStoragePath(path), encoded: true };
}

/** Whether a physical path could be either encoded or a literal legacy name. */
export function isStoragePathCodecCandidate(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.every(
      (segment) => segment === "" || SUPABASE_SAFE_SEGMENT.test(segment),
    ) &&
    segments.some((segment) => segment.startsWith(ENCODED_SEGMENT_PREFIX))
  );
}

export interface StoragePathCandidates {
  canonical: string;
  legacy?: string;
}

/**
 * Return the canonical physical path first, followed by the pre-codec raw path
 * when they differ. The latter keeps existing Workspace objects readable and
 * writable in place; any bulk migration remains an explicit operation.
 */
export function storagePathCandidates(path: string): StoragePathCandidates {
  const encoded = encodeStoragePath(path);
  return encoded === path
    ? { canonical: path }
    : { canonical: encoded, legacy: path };
}
