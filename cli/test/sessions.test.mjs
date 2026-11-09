import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, json, run, auth } from "./helpers.mjs";
const event = (seq, type, data = {}) => ({
  sessionId: "s",
  seq,
  type,
  data,
  ts: "now",
  sessionThreadId: "sthr_primary",
});
test("send validates wait flags before submitting and wraps one text message; delete only hides", async () => {
  const f = await fixture((req, res) =>
    json(
      res,
      req.url.endsWith("/events")
        ? { accepted: true, interrupted: false }
        : { type: "session_deleted", id: "s" },
      202,
    ),
  );
  try {
    const bad = await run(
      ["session", "send", "--session-id", "s", "--prompt", "hi", "--stream"],
      auth(f),
    );
    assert.equal(bad.code, 2);
    assert.equal(f.requests.length, 0);
    const r = await run(
      ["session", "send", "--session-id", "s", "--prompt-file", "-"],
      { ...auth(f), input: "你好\n" },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(f.requests[0].body), {
      events: [
        {
          type: "user.message",
          data: { content: [{ type: "text", text: "你好\n" }] },
        },
      ],
    });
    const d = await run(
      ["session", "delete", "--session-id", "s", "--yes"],
      auth(f),
    );
    assert.equal(d.code, 0, d.stderr);
    assert.equal(f.requests[1].method, "POST");
    assert.deepEqual(JSON.parse(f.requests[1].body), { deleted: true });
  } finally {
    await f.close();
  }
});
test("wait drains multiple Turns and returns every text block of only the last Turn", async () => {
  let reads = 0;
  const events = [
    event(1, "user.message"),
    event(2, "agent.message", {
      turnId: "arbitrary-A",
      content: [{ type: "text", text: "A" }],
    }),
    event(3, "session.turn_completed", { turnId: "arbitrary-A" }),
    event(4, "user.message"),
    event(5, "agent.message", {
      turnId: "arbitrary-B",
      content: [
        { type: "text", text: "B1" },
        { type: "text", text: "B2" },
      ],
    }),
    event(6, "session.turn_completed", { turnId: "arbitrary-B" }),
    event(7, "session.status_idle"),
  ];
  const f = await fixture((req, res) => {
    if (req.url.includes("/events?")) {
      const n = Number(
        new URL(req.url, "http://x").searchParams.get("after_seq"),
      );
      json(res, {
        data: events.filter((e) => e.seq > n).slice(0, reads < 2 ? 3 : 99),
        has_more: false,
      });
    } else json(res, { id: "s", status: ++reads < 2 ? "running" : "idle" });
  });
  try {
    const r = await run(
      ["session", "wait", "--session-id", "s", "--wait-timeout", "3s"],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.data().data.messages, [
      {
        seq: 5,
        content: [
          { type: "text", text: "B1" },
          { type: "text", text: "B2" },
        ],
      },
    ]);
    assert.ok(reads >= 3);
  } finally {
    await f.close();
  }
});
test("follow requires explicit frame IDs, deduplicates reconnects and runs past idle", async () => {
  let connects = 0;
  const f = await fixture((req, res) => {
    assert.equal(req.headers.accept, "text/event-stream");
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (++connects === 1) {
      assert.equal(req.headers["last-event-id"], "0");
      res.end(
        'event: agent.message\nid: 1\ndata: {"content":[]}\n\nevent: agent.message_start\ndata: {"turnId":"a"}\n\n',
      );
    } else {
      assert.equal(req.headers["last-event-id"], "1");
      res.write(
        "event: agent.message\nid: 1\ndata: {}\n\nevent: session.status_idle\nid: 2\ndata: {}\n\n",
      );
      const timer = setInterval(() => res.write(": keepalive\n\n"), 20);
      res.on("close", () => clearInterval(timer));
    }
  });
  try {
    const r = await run(
      [
        "session",
        "events",
        "follow",
        "--session-id",
        "s",
        "--duration",
        "500ms",
        "--timeout",
        "100ms",
      ],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.stdout
        .trim()
        .split("\n")
        .map(JSON.parse)
        .map((e) => [e.kind, e.seq, e.type]),
      [
        ["event", 1, "agent.message"],
        ["event", 2, "session.status_idle"],
      ],
    );
  } finally {
    await f.close();
  }
});

test("wait drains a fast new Turn that finishes between final state and history reads", async () => {
  const old = [
    event(1, "user.message"),
    event(2, "agent.message", {
      turnId: "a",
      content: [{ type: "text", text: "A" }],
    }),
    event(3, "session.turn_completed", { turnId: "a" }),
    event(4, "session.status_idle"),
  ];
  const fresh = [
    event(5, "user.message"),
    event(6, "agent.message", {
      turnId: "b",
      content: [{ type: "text", text: "B" }],
    }),
    event(7, "session.turn_completed", { turnId: "b" }),
    event(8, "session.status_idle"),
  ];
  let states = 0;
  const f = await fixture((req, res) => {
    if (req.url.includes("/events?")) {
      const after = Number(
        new URL(req.url, "http://x").searchParams.get("after_seq"),
      );
      json(res, {
        data: [...old, ...(states >= 3 ? fresh : [])].filter(
          (e) => e.seq > after,
        ),
        has_more: false,
      });
    } else {
      states++;
      json(res, { status: "idle" });
    }
  });
  try {
    const r = await run(
      [
        "session",
        "wait",
        "--session-id",
        "s",
        "--stream",
        "--wait-timeout",
        "2s",
      ],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    const rows = r.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((r) => r.kind === "result").length, 1);
    assert.equal(rows.at(-1).data.messages[0].content[0].text, "B");
    assert.deepEqual(
      rows.filter((r) => r.kind === "event").map((r) => r.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  } finally {
    await f.close();
  }
});
test("accepted send timeout and SIGINT stop observation without resending or interrupting", async () => {
  const f = await fixture((req, res) =>
    json(
      res,
      req.method === "POST"
        ? { accepted: true }
        : req.url.includes("/events?")
          ? { data: [], has_more: false }
          : { status: "running" },
      req.method === "POST" ? 202 : 200,
    ),
  );
  try {
    const r = await run(
      [
        "session",
        "send",
        "--session-id",
        "s",
        "--prompt",
        "hi",
        "--wait",
        "--wait-timeout",
        "100ms",
      ],
      auth(f),
    );
    assert.equal(r.code, 124);
    assert.equal(r.stdout, "");
    assert.equal(r.error().retryable, false);
    assert.match(r.error().hint, /Do not resend/);
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    const interrupt = await run(
      ["session", "wait", "--session-id", "s", "--wait-timeout", "0"],
      { ...auth(f), signalAfter: 250 },
    );
    assert.equal(interrupt.code, 130, interrupt.stderr);
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  } finally {
    await f.close();
  }
});

test("long deadlines do not clamp and transient wait reads recover without duplicating events", async () => {
  let eventReads = 0;
  const events = [
    event(1, "user.message"),
    event(2, "agent.message", {
      turnId: "a",
      content: [{ type: "text", text: "done" }],
    }),
    event(3, "session.turn_completed", { turnId: "a" }),
    event(4, "session.status_idle"),
  ];
  const f = await fixture((req, res) => {
    if (req.url.includes("/events?")) {
      if (++eventReads === 2) {
        req.socket.destroy();
        return;
      }
      const after = Number(
        new URL(req.url, "http://x").searchParams.get("after_seq"),
      );
      json(res, { data: events.filter((e) => e.seq > after), has_more: false });
    } else json(res, { status: "idle" });
  });
  try {
    const r = await run(
      [
        "session",
        "wait",
        "--session-id",
        "s",
        "--stream",
        "--wait-timeout",
        "720h",
        "--timeout",
        "720h",
      ],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.deepEqual(
      r.stdout
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((x) => x.kind === "event")
        .map((x) => x.seq),
      [1, 2, 3, 4],
    );
  } finally {
    await f.close();
  }
});

test("session create exposes and transmits Idempotency-Key, including dry-run, without changing the body", async () => {
  const f = await fixture((_req, res) => json(res, { id: "sess_existing" }, 201));
  try {
    const args = ["session", "create", "--agent-id", "agent_a", "--idempotency-key", "job:123"];
    const schema = await run(["schema", "session", "create"]);
    assert.match(schema.data().data.flags["idempotency-key"].description, /Idempotency-Key/);
    const dry = await run([...args, "--dry-run"], auth(f));
    assert.equal(dry.code, 10, dry.stderr);
    assert.deepEqual(dry.data().data.steps[0].headers, { "Idempotency-Key": "job:123" });
    assert.deepEqual(dry.data().data.steps[0].body, { agent: "agent_a" });
    assert.equal(f.requests.length, 0);
    const created = await run(args, auth(f));
    assert.equal(created.code, 0, created.stderr);
    assert.equal(f.requests[0].headers["idempotency-key"], "job:123");
    assert.deepEqual(JSON.parse(f.requests[0].body), { agent: "agent_a" });
    const plain = await run(["session", "create", "--agent-id", "agent_a"], auth(f));
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(f.requests[1].headers["idempotency-key"], undefined);
    const body = await run(["session", "create", "--idempotency-key", "from-body", "--body", '{"agent":"agent_a","workspace_id":"shared"}'], auth(f));
    assert.equal(body.code, 0, body.stderr);
    assert.equal(f.requests[2].headers["idempotency-key"], "from-body");
    assert.deepEqual(JSON.parse(f.requests[2].body), { agent: "agent_a", workspace_id: "shared" });
  } finally { await f.close(); }
});

test("session create validates idempotency keys before networking", async () => {
  const f = await fixture((_req, res) => json(res, {}));
  try {
    for (const key of ["", "a b", "a\nb", "a".repeat(129), "中文"]) {
      const bad = await run(["session", "create", "--agent-id", "a", "--idempotency-key", key], auth(f));
      assert.equal(bad.code, 2, bad.stderr);
      assert.equal(bad.error().param, "--idempotency-key");
    }
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("session creation conflicts preserve sessionId and failures are not automatically retried", async () => {
  let conflict = true;
  const f = await fixture((req, res) => {
    if (conflict) json(res, { error: "This Idempotency-Key was already used with different Session creation parameters.", code: "idempotency_key_conflict", sessionId: "sess_original" }, 409);
    else req.socket.destroy();
  });
  try {
    const args = ["session", "create", "--agent-id", "a", "--idempotency-key", "job-1"];
    const bad = await run(args, auth(f));
    assert.equal(bad.code, 5, bad.stderr);
    assert.equal(bad.error().subtype, "idempotency_key_conflict");
    assert.equal(bad.error().sessionId, "sess_original");
    conflict = false;
    const lost = await run(args, auth(f));
    assert.notEqual(lost.code, 0);
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});
