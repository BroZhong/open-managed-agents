import { deadline } from "./deadline.js";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError, invalid, normalizeError } from "./errors.js";
import { duration } from "./input.js";
import type { Context, Values, Result } from "./types.js";
import { base } from "./commands/common.js";
export type Event = {
  seq: number;
  type: string;
  data: any;
  [key: string]: any;
};
export async function history(
  c: Context,
  after = 0,
  limit = 1000,
  all = true,
): Promise<{ data: Event[]; meta: Values }> {
  const data: Event[] = [];
  while (true) {
    const r = await c.http.request(
      base(c, "session") + `/events?after_seq=${after}&limit=${limit}`,
    );
    if (!Array.isArray(r.data)) throw new Error("Invalid event page");
    for (const e of r.data) {
      if (!Number.isSafeInteger(e.seq) || e.seq <= after)
        throw new Error("Event page did not advance");
      after = e.seq;
      data.push(e);
    }
    if (!all || !r.has_more) return { data, meta: { has_more: !!r.has_more } };
    if (!r.data.length) throw new Error("Empty event page claims more events");
  }
}
export function streamFormat(f: Values) {
  if (f.field || (f.format && f.format !== "ndjson"))
    invalid("Streaming requires ndjson without --field", "--format");
}
export function emit(c: Context, e: Event) {
  c.write(
    JSON.stringify({ kind: "event", type: e.type, seq: e.seq, data: e.data }) +
      "\n",
  );
}
export async function follow(c: Context): Promise<Result> {
  const limit = duration(c.flags.duration, "--duration");
  const stop = deadline(limit, new Error("Observation duration elapsed"));
  const signal = AbortSignal.any([c.signal, stop.signal]);
  let cursor = c.flags["after-seq"],
    failures = 0,
    retry = 100;
  try {
    while (!signal.aborted) {
      const connection = new AbortController();
      let watchdog: ReturnType<typeof deadline> | undefined;
      const touch = () => {
        watchdog?.cancel();
        const activity = deadline(
          c.http.timeout,
          new CliError(
            {
              type: "timeout",
              subtype: "http_timeout",
              message: "SSE transport stalled",
              hint: "Resume events follow with the last printed --after-seq.",
              retryable: true,
            },
            124,
          ),
        );
        watchdog = activity;
        activity.signal.addEventListener(
          "abort",
          () => connection.abort(activity.signal.reason),
          { once: true },
        );
      };
      try {
        touch();
        const stream = await c.http.request(
          base(c, "session") + "/events",
          "GET",
          undefined,
          {
            stream: true,
            noTimeout: true,
            headers: {
              accept: "text/event-stream",
              "Last-Event-ID": String(cursor),
            },
            signal: AbortSignal.any([signal, connection.signal]),
          },
        );
        let buffer = "",
          frame: { id?: string; type?: string; data: string[] } = { data: [] };
        const decoder = new TextDecoder();
        // A frame-local id is essential: SSE lastEventId inheritance would admit Deltas.
        for await (const chunk of stream) {
          touch();
          buffer += decoder.decode(chunk, { stream: true });
          let match: RegExpExecArray | null;
          while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (line === "") {
              if (
                frame.id !== undefined &&
                /^(0|[1-9]\d*)$/.test(frame.id) &&
                frame.data.length
              ) {
                const seq = Number(frame.id);
                if (Number.isSafeInteger(seq) && seq > cursor) {
                  const data = JSON.parse(frame.data.join("\n"));
                  emit(c, { seq, type: frame.type ?? "message", data });
                  cursor = seq;
                  failures = 0;
                }
              }
              frame = { data: [] };
              continue;
            }
            if (line.startsWith(":")) {
              failures = 0;
              continue;
            }
            const colon = line.indexOf(":");
            const key = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (key === "id") frame.id = value;
            else if (key === "event") frame.type = value;
            else if (key === "data") frame.data.push(value);
            else if (key === "retry" && /^\d+$/.test(value))
              retry = Math.max(50, Math.min(5000, Number(value)));
          }
        }
        if (++failures > 5)
          throw new Error("SSE repeatedly closed without progress");
      } catch (e) {
        if (signal.aborted) break;
        const err = normalizeError(e);
        if (
          !["network", "timeout", "internal"].includes(err.info.type) ||
          ++failures > 5
        )
          throw err;
      } finally {
        watchdog?.cancel();
        connection.abort();
      }
      if (!signal.aborted)
        await sleep(retry, undefined, { signal }).catch(() => {});
    }
    c.signal.throwIfAborted();
    return { data: null, silent: true };
  } finally {
    stop.cancel();
  }
}
const inputs = new Set([
  "user.message",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "delegation.input",
  "subagent.result_claimed",
]);
function latestStart(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--)
    if (inputs.has(events[i]!.type)) return i;
  return events.length;
}
function lastMessages(events: Event[]): Values[] {
  const slice = events.slice(latestStart(events));
  const completion = [...slice]
    .reverse()
    .find((e) => e.type === "session.turn_completed");
  if (!completion) return [];
  return slice
    .filter(
      (e) =>
        e.seq < completion.seq &&
        e.type === "agent.message" &&
        (!completion.data?.turnId || e.data?.turnId === completion.data.turnId),
    )
    .flatMap((e) => {
      const content = Array.isArray(e.data?.content)
        ? e.data.content.filter(
            (b: any) => b.type === "text" && typeof b.text === "string",
          )
        : [];
      return content.length ? [{ seq: e.seq, content }] : [];
    });
}
function terminated(status: string) {
  if (status === "terminated")
    throw new CliError(
      {
        type: "conflict",
        subtype: "session_terminated",
        message: "Session is terminated",
        hint: "Inspect the Session history; create a new Session to continue.",
        retryable: false,
      },
      5,
    );
}
export async function waitSession(
  c: Context,
  initial?: Event[],
): Promise<Result> {
  const timeout = duration(c.flags["wait-timeout"], "--wait-timeout");
  const expired = deadline(
    timeout,
    new CliError(
      {
        type: "timeout",
        subtype: "wait_timeout",
        message: "Local wait timed out; remote execution continues",
        hint: `Run oma-cli session wait --session-id ${c.flags["session-id"]}`,
        retryable: true,
      },
      124,
    ),
  );
  const previousSignal = c.http.signal;
  const signal = AbortSignal.any([c.signal, expired.signal]);
  c.http.signal = signal;
  try {
    let events = initial ?? (await history(c)).data;
    let emitted = initial?.at(-1)?.seq ?? 0;
    const output = (first = false) => {
      if (!c.flags.stream) return;
      const start = first ? latestStart(events) : 0;
      for (const e of events.slice(start))
        if (e.seq > emitted) {
          emit(c, e);
          emitted = e.seq;
        }
    };
    if (!initial) output(true);
    emitted = events.at(-1)?.seq ?? 0;
    let cursor = events.at(-1)?.seq ?? 0;
    const collect = async () => {
      const newEvents = (await history(c, cursor)).data;
      events.push(...newEvents);
      cursor = events.at(-1)?.seq ?? 0;
      output();
      return newEvents.length;
    };
    while (true) {
      signal.throwIfAborted();
      const state = await c.http.request(base(c, "session"));
      terminated(state.status);
      await collect();
      if (state.status === "idle") {
        const confirmed = await c.http.request(base(c, "session"));
        terminated(confirmed.status);
        if (confirmed.status === "idle") {
          // Idle and its lifecycle event commit atomically on the required #179 Host.
          // Drain AFTER observing idle, then recheck to include input accepted during reads.
          await collect();
          const final = await c.http.request(base(c, "session"));
          terminated(final.status);
          if (final.status === "idle") {
            if (await collect()) continue;
            const latest = events.slice(latestStart(events));
            if (
              latest.length &&
              !latest.some((e) => e.type === "session.turn_completed")
            )
              throw new CliError(
                {
                  type: "internal",
                  subtype: "wait_contract_unavailable",
                  message: "Idle Session lacks a durable Turn completion",
                  hint: "Verify the Host includes PR #179 and inspect Session history.",
                  retryable: false,
                },
                1,
              );
            const result = {
              ok: true,
              command: c.command.path,
              data: {
                sessionId: c.flags["session-id"],
                status: "idle",
                messages: lastMessages(events),
              },
              meta: {},
            };
            if (c.flags.stream) {
              c.write(JSON.stringify({ kind: "result", ...result }) + "\n");
              return { data: null, silent: true };
            }
            return { data: result.data };
          }
        }
      }
      await sleep(200, undefined, { signal }).catch(() =>
        signal.throwIfAborted(),
      );
    }
  } finally {
    expired.cancel();
    c.http.signal = previousSignal;
  }
}
