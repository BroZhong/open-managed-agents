import { describe, expect } from "vitest";
import { sweep, text, usePiSettings, type Outcome, type Scenario } from "./harness.js";

await usePiSettings();

const long = (label: string) => `${label} ` + "detail ".repeat(80);
/** Each summary request gets a summary of its own, so a summary in a request names the request that made it. */
const summary = (index: number) => ({ blocks: [text(`SUMMARY ${index}`)], stop: "end_turn" as const });

/**
 * B1/B2: the first answer fills the small window, so Pi compacts right after
 * it; the second Turn must run on the committed summary.
 */
const threshold: Scenario = {
  inputs: [long("first question"), "second question"],
  contextWindow: 2000,
  model: (request) => request.summary ? summary(request.index)
    : request.lastUser === "second question" ? { blocks: [text("second answer")], stop: "end_turn", inputTokens: 10 }
    : { blocks: [text(long("first answer"))], stop: "end_turn", inputTokens: 1950 },
};

/**
 * B3: the second Turn's request is too large until Pi compacts on the
 * provider's overflow error and retries.
 */
const overflow: Scenario = {
  inputs: [long("first question"), "second question"],
  model: (request) => request.summary ? summary(request.index)
    : request.lastUser !== "second question" ? { blocks: [text(long("first answer"))], stop: "end_turn" }
    : request.text.includes("SUMMARY") ? { blocks: [text("second answer")], stop: "end_turn" }
    : { error: { status: 413, type: "request_too_large", message: "Request exceeds the maximum size" } },
};

const summariesIn = (value: string) => [...value.matchAll(/SUMMARY (\d+)/g)].map((match) => match[1]);
const committedSummaries = (outcome: Outcome) => outcome.log.filter((event) => event.type === "agent.context_entry" &&
  (event.data as { entry?: { type?: string } }).entry?.type === "compaction")
  .flatMap((event) => summariesIn((event.data as { entry: { summary: string } }).entry.summary));

/** A summary reaches the model only once its compaction boundary is committed, and the second Turn runs on one. */
function expectCommittedSummariesOnly(outcome: Outcome) {
  const committed = committedSummaries(outcome);
  for (const request of outcome.requests.filter((sent) => !sent.summary)) {
    for (const used of summariesIn(request.text)) expect(committed, `request ${request.index} uses SUMMARY ${used}`).toContain(used);
  }
  const second = outcome.requests.filter((sent) => !sent.summary && sent.lastUser === "second question").at(-1)!;
  expect(summariesIn(second.text)).not.toEqual([]);
}

describe("crash injection: threshold compaction after the final answer", async () => {
  await sweep(threshold, expectCommittedSummariesOnly);
});

describe("crash injection: overflow compaction of a request that is too large", async () => {
  await sweep(overflow, (outcome) => {
    expectCommittedSummariesOnly(outcome);
    // Each attempt compacts on overflow at most once; the Turn ends answered.
    const attempts = outcome.attempts.filter((attempt) => attempt.input.message.content.some((block) => block.type === "text" && block.text === "second question"));
    const overflows = outcome.log.filter((event) => event.type === "agent.compaction" && (event.data as { reason?: string; status?: string }).reason === "overflow"
      && (event.data as { status?: string }).status === "completed");
    expect(overflows.length).toBeLessThanOrEqual(attempts.length);
    const answers = outcome.log.filter((event) => event.type === "agent.context_entry" &&
      (event.data as { entry?: { message?: { role?: string; stopReason?: string } } }).entry?.message?.role === "assistant" &&
      (event.data as { entry: { message: { stopReason?: string } } }).entry.message.stopReason === "stop");
    expect(JSON.stringify(answers.at(-1)?.data)).toContain("second answer");
  });
});
