import { CliError, invalid, redact } from "./errors.js";
import { duration } from "./input.js";
import type { Values } from "./types.js";
export class Http {
  readonly base: string;
  readonly key: string;
  readonly timeout: number;
  constructor(
    public flags: Values,
    public signal: AbortSignal,
  ) {
    this.base = flags["base-url"] ?? process.env.OMA_BASE_URL ?? "";
    this.key = flags["api-key"] ?? process.env.OMA_API_KEY ?? "";
    this.timeout = duration(flags.timeout ?? "30s", "--timeout", false);
  }
  configured() {
    if (!this.base) invalid("Set --base-url or OMA_BASE_URL", "--base-url");
    this.url("");
    if (!this.key) invalid("Set --api-key or OMA_API_KEY", "--api-key");
  }
  url(path: string): string {
    let u: URL;
    try {
      u = new URL(this.base);
    } catch {
      invalid("Invalid base URL", "--base-url");
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      invalid(
        "Use an HTTP(S) base URL without credentials, query or fragment",
        "--base-url",
      );
    return this.base.replace(/\/+$/, "") + path;
  }
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    options: {
      signed?: boolean;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      bytes?: boolean;
      stream?: boolean;
      noTimeout?: boolean;
    } = {},
  ): Promise<any> {
    const signed = options.signed ?? false;
    if (!signed) this.configured();
    const url = signed ? path : this.url(path);
    if (signed && !/^https?:\/\//i.test(url)) invalid("Invalid signed URL");
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
      ...(!signed ? { "x-api-key": this.key } : {}),
    };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (this.flags.verbose)
      process.stderr.write(
        JSON.stringify({
          method,
          url: signed ? "[signed URL]" : this.url(path.split("?")[0]!),
        }) + "\n",
      );
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: payload,
        redirect: signed ? "follow" : "error",
        signal: AbortSignal.any([
          this.signal,
          ...(options.signal ? [options.signal] : []),
          ...(options.noTimeout ? [] : [AbortSignal.timeout(this.timeout)]),
        ]),
      });
      if (!response.ok) {
        let raw: any;
        try {
          raw = await response.json();
        } catch {
          raw = {};
        }
        const status = response.status;
        const type =
          status === 401 || status === 403
            ? "auth"
            : status === 404
              ? "not_found"
              : status === 409 || status === 410
                ? "conflict"
                : status === 400 || status === 422
                  ? "validation"
                  : "internal";
        const known =
          typeof raw.error === "object" && raw.error ? raw.error : {};
        throw new CliError(
          {
            type: known.type ?? type,
            subtype:
              known.subtype ??
              raw.code ??
              (status === 410 ? "session_terminated" : `http_${status}`),
            message:
              typeof raw.error === "string"
                ? raw.error
                : (known.message ?? `HTTP ${status}`),
            param: known.param,
            hint:
              known.hint ??
              (type === "auth"
                ? "Check the API key and its permissions."
                : type === "not_found"
                  ? "Check the explicit resource ID and path."
                  : method === "GET"
                    ? "Inspect the service and try this read again."
                    : "Inspect remote state before retrying this operation."),
            retryable: known.retryable ?? (method === "GET" && status >= 500),
          },
          { validation: 2, not_found: 3, auth: 4, conflict: 5, internal: 1 }[
            type
          ],
        );
      }
      return options.stream
        ? response.body
        : options.bytes
          ? new Uint8Array(await response.arrayBuffer())
          : await response.json();
    } catch (e) {
      if (e instanceof CliError)
        throw new CliError(redact(e.info, [this.key]) as typeof e.info, e.code);
      if (this.signal.aborted || options.signal?.aborted)
        throw this.signal.reason ?? options.signal?.reason;
      const timeout = (e as Error).name === "TimeoutError";
      throw new CliError(
        {
          type: timeout ? "timeout" : "network",
          subtype: timeout ? "http_timeout" : "request_failed",
          message: timeout ? "HTTP request timed out" : "HTTP request failed",
          hint:
            method === "GET"
              ? "Check connectivity and retry the read."
              : "The request may have been accepted. Inspect remote state before submitting again.",
          retryable: method === "GET",
        },
        timeout ? 124 : 1,
      );
    }
  }
  async pages(
    path: string,
    flags: Values,
    project?: (x: any) => unknown,
  ): Promise<{ data: any[]; meta: Values }> {
    const data: any[] = [];
    let cursor = flags.cursor;
    const seen = new Set<string>();
    while (true) {
      const q = new URLSearchParams({ limit: String(flags.limit ?? 50) });
      if (cursor !== undefined) q.set("cursor", cursor);
      for (const [k, v] of Object.entries(flags.query ?? {}))
        if (v !== undefined) q.set(k, String(v));
      const page = await this.request(path + "?" + q);
      if (!Array.isArray(page.data)) throw new Error("Invalid list response");
      data.push(...page.data.map(project ?? ((x: any) => x)));
      const meta: Values = { has_more: !!page.has_more };
      if (page.has_more && page.next_cursor !== undefined)
        meta.next_cursor = page.next_cursor;
      if (!flags.all || !page.has_more) return { data, meta };
      if (!page.next_cursor || seen.has(page.next_cursor))
        throw new Error("Pagination did not advance");
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  }
}
export function pick(value: any, fields: string[]): Values {
  return Object.fromEntries(
    fields.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  );
}
