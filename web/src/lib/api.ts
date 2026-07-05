import { QueryClient } from "@tanstack/react-query";

export const BASE_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const STORAGE_KEY = "oma_api_key";

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = localStorage.getItem(STORAGE_KEY);

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const method = (options.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

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
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * POST a `FormData` body (multipart) with auth, without forcing a JSON
 * Content-Type — the browser sets the multipart boundary itself. Used for the
 * Skill folder upload (POST /v1/skills).
 */
export async function apiUpload<T = unknown>(path: string, form: FormData): Promise<T> {
  const token = localStorage.getItem(STORAGE_KEY);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: form,
  });

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
      `Upload failed with status ${response.status}`;
    throw new Error(message);
  }
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});
