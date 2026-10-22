import { QueryClient } from "@tanstack/react-query";

export const BASE_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STORAGE_KEY = "oma_api_key";

/** The console's API credential, if signed in. */
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(STORAGE_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Send the user to login on 401; throw the API's error for any other failure. */
async function ensureOk(response: Response, failure: string): Promise<void> {
  if (response.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      (body as { message?: string }).message ??
      (body as { error?: string }).error ??
      `${failure} with status ${response.status}`;
    throw new ApiError(message, response.status, (body as { code?: string }).code);
  }
}

async function jsonBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    ...authHeaders(),
  };

  const method = (options.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
  await ensureOk(response, "Request failed");
  return jsonBody<T>(response);
}

/**
 * POST a `FormData` body (multipart) with auth, without forcing a JSON
 * Content-Type — the browser sets the multipart boundary itself. Used for the
 * Skill folder upload (POST /v1/skills) and the Workspace and Skill file uploads.
 */
export async function apiUpload<T = unknown>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  await ensureOk(response, "Upload failed");
  return jsonBody<T>(response);
}

/**
 * GET a response body as bytes with auth, for content a media element or
 * download link cannot fetch itself because it needs the API credential
 * (Skill file bytes). The Blob's type is the response's Content-Type.
 */
export async function apiBlob(path: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: authHeaders(),
    signal: options.signal,
    cache: "no-store",
  });
  await ensureOk(response, "Download failed");
  return response.blob();
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});
