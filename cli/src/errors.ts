export type ErrorInfo = {
  type: string;
  subtype: string;
  message: string;
  param?: string;
  hint: string;
  retryable: boolean;
};
export class CliError extends Error {
  constructor(
    public info: ErrorInfo,
    public code: number,
  ) {
    super(info.message);
  }
}
export function invalid(
  message: string,
  param?: string,
  subtype = "invalid_argument",
): never {
  throw new CliError(
    {
      type: "validation",
      subtype,
      message,
      param,
      hint: "Run oma-cli schema <command path> or the command with --help.",
      retryable: false,
    },
    2,
  );
}
export function conflict(
  message: string,
  hint = "Inspect the destination; use --overwrite only to replace it.",
): never {
  throw new CliError(
    { type: "conflict", subtype: "conflict", message, hint, retryable: false },
    5,
  );
}
export function normalizeError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const errno = (e as NodeJS.ErrnoException)?.code;
  return new CliError(
    {
      type: errno === "ENOENT" ? "not_found" : "internal",
      subtype: errno ?? "internal",
      message: e instanceof Error ? e.message : String(e),
      hint: "Check the input and remote state before trying again.",
      retryable: false,
    },
    errno === "ENOENT" ? 3 : 1,
  );
}
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string")
    return secrets
      .filter(Boolean)
      .reduce((s, key) => s.split(key).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /api.?key|authorization|password|secret|token|^(content|text|system|prompt)$/i.test(
          k,
        )
          ? "[REDACTED]"
          : redact(v, secrets),
      ]),
    );
  return value;
}
