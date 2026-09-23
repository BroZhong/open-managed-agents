import { redact, normalizeError, conflict } from "../errors.js";
import type { Context, Result, Step, Values } from "../types.js";
export const enc = encodeURIComponent;
export function base(c: Context, noun: string): string {
  return `/v1/${noun}s/${enc(c.flags[`${noun}-id`])}`;
}
export function plan(c: Context, steps: Step[]): Result {
  return {
    data: {
      steps: steps.map(({ path, ...s }) => ({
        ...s,
        url: c.http.url(path),
        ...(s.body !== undefined ? { body: redact(s.body, [c.http.key]) } : {}),
        effects: s.effects ?? c.command.effects ?? c.command.description,
      })),
    },
    code: 10,
  };
}
export async function write(
  c: Context,
  step: Step,
  project?: (x: any) => unknown,
): Promise<Result> {
  if (c.flags["dry-run"]) return plan(c, [step]);
  const data = await c.http.request(step.path, step.method, step.body);
  return { data: project ? project(data) : data };
}
export async function exists(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (e) {
    if (normalizeError(e).code === 3) return false;
    throw e;
  }
}
export async function noTarget(
  read: () => Promise<unknown>,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite && (await exists(read)))
    conflict("Destination already exists");
}
export function batch(data: Values[]): Result {
  const meta = { succeeded: 0, failed: 0, unknown: 0 };
  for (const item of data) meta[item.status as keyof typeof meta]++;
  return {
    data,
    meta,
    ok: meta.failed + meta.unknown === 0,
    code: meta.failed + meta.unknown ? 1 : 0,
  };
}
export function failure(e: unknown, submitted = false): Values {
  const error = normalizeError(e);
  return {
    status:
      submitted &&
      (["network", "timeout"].includes(error.info.type) ||
        /^http_5/.test(error.info.subtype))
        ? "unknown"
        : "failed",
    error: error.info,
  };
}
