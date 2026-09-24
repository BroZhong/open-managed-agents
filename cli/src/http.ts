import { setTimeout as sleep } from "node:timers/promises";
import { deadline } from "./deadline.js";
import { CliError, invalid, redact } from "./errors.js";
import { duration } from "./input.js";
import type { Values } from "./types.js";
type RequestOptions = {
  signed?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  bytes?: boolean;
  stream?: boolean;
  noTimeout?: boolean;
};
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
    options: RequestOptions = {},
  ): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(path, method, body, options);
      } catch (e) {
        if (this.signal.aborted) throw this.signal.reason;
        if (options.signal?.aborted) throw options.signal.reason;
        const transient =
          e instanceof CliError &&
          (["network", "timeout"].includes(e.info.type) ||
            /^http_5/.test(e.info.subtype));
        if (
          !["GET", "HEAD"].includes(method) ||
          options.noTimeout ||
          !transient ||
          attempt >= 2
        )
          throw e;
        const signal = AbortSignal.any([
          this.signal,
          ...(options.signal ? [options.signal] : []),
        ]);
        await sleep(100 * (attempt + 1), undefined, { signal }).catch(() => {
          signal.throwIfAborted();
        });
      }
    }
  }
  private async once(
    path: string,
    method: string,
    body: unknown,
    options: RequestOptions,
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
    const timeout = deadline(
      options.noTimeout ? 0 : this.timeout,
      new CliError(
        {
          type: "timeout",
          subtype: "http_timeout",
          message: "HTTP request timed out",
          hint:
            method === "GET"
              ? "Retry the read."
              : "The request may have been accepted. Inspect remote state before submitting again.",
          retryable: method === "GET",
        },
        124,
      ),
    );
    let streaming = false;
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: payload,
        redirect: signed ? "follow" : "error",
        signal: AbortSignal.any([
          this.signal,
          ...(options.signal ? [options.signal] : []),
          timeout.signal,
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
      if (options.stream) {
        if (!response.body) throw new Error("Missing HTTP response body");
        streaming = true;
        const source = response.body;
        return (async function* () {
          try {
            for await (const chunk of source) yield chunk;
          } catch (e) {
            if (timeout.signal.aborted) throw timeout.signal.reason;
            throw e;
          } finally {
            timeout.cancel();
          }
        })();
      }
      if (options.bytes) return new Uint8Array(await response.arrayBuffer());
      try {
        return await response.json();
      } catch {
        const contentType = response.headers.get("content-type") ?? "unknown";
        throw new CliError(
          {
            type: "validation",
            subtype: "non_json_response",
            message: `Expected JSON response from OMA Host, received ${contentType}`,
            hint:
              "Check OMA_BASE_URL points to the OMA API root (for example /api), not a web-console path or /v1.",
            retryable: false,
          },
          2,
        );
      }
    } catch (e) {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (e instanceof CliError)
        throw new CliError(redact(e.info, [this.key]) as typeof e.info, e.code);
      if (this.signal.aborted || options.signal?.aborted)
        throw this.signal.reason ?? options.signal?.reason;
      const timedOut = (e as Error).name === "TimeoutError";
      throw new CliError(
        {
          type: timedOut ? "timeout" : "network",
          subtype: timedOut ? "http_timeout" : "request_failed",
          message: timedOut ? "HTTP request timed out" : "HTTP request failed",
          hint:
            method === "GET"
              ? "Check connectivity and retry the read."
              : "The request may have been accepted. Inspect remote state before submitting again.",
          retryable: method === "GET",
        },
        timedOut ? 124 : 1,
      );
    } finally {
      if (!streaming) timeout.cancel();
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
