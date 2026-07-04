import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import {
  buildPromptWithHistory,
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import { buildCustomTools } from "./custom-tools.js";
import { resolveModel } from "./model-resolver.js";
import { PiEventTranslator } from "./translator.js";

/**
 * The subset of the Pi SDK `AgentSession` this adapter drives. Declaring it as
 * a structural interface (rather than importing the concrete class) gives us
 * the test seam: `_sessionFactory` can return any object with this shape, so
 * unit tests drive the adapter without a real model / network.
 */
export interface PiSessionLike {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  dispose(): void;
}

/**
 * The `DefaultResourceLoaderOptions` fields this adapter drives per run().
 * Assembled from `input.agent` in {@link buildResourceLoaderOptions} so the
 * adapter-seam test can assert exactly what the resource loader receives
 * without a real model / network.
 */
export interface PiResourceLoaderOptions {
  /**
   * Instruction text appended to Pi's system prompt, in order: the Agent's
   * `system` first (previously discarded — now wired through), then any
   * Host-assembled `appendSystemPrompt` entries (e.g. Agent Files).
   */
  appendSystemPrompt: string[];
  /** Host-materialized equipped-Skill directories (`additionalSkillPaths`). */
  additionalSkillPaths: string[];
  /** Host owns instructions; never auto-discover cwd context files. */
  noContextFiles: true;
}

/** Everything the adapter needs to spin up a Pi session for one run(). */
export interface SessionFactoryArgs {
  input: AdapterInput;
  prompt: string;
  /** Resolved from `input.agent.model`; opaque Pi Model. */
  model: unknown;
  /** True when a per-run() ToolExecutor was injected. */
  hasToolExecutor: boolean;
  /**
   * Resource-loader options assembled from `input.agent` for this run — the
   * injected instructions + Skill paths the Pi session will load. Exposed on
   * the factory args so the adapter-seam test can assert them directly.
   */
  resourceLoaderOptions: PiResourceLoaderOptions;
}

/**
 * Assemble the per-run() Pi resource-loader options from an Agent's config.
 * The Agent's `system` (historically discarded) leads the appended prompt,
 * followed by any Host-assembled `appendSystemPrompt` entries; equipped Skill
 * directories become `additionalSkillPaths`. Empty/whitespace-only entries are
 * dropped so a blank system prompt does not inject an empty block.
 */
export function buildResourceLoaderOptions(
  agent: AdapterInput["agent"],
): PiResourceLoaderOptions {
  const appendSystemPrompt = [agent.system, ...(agent.appendSystemPrompt ?? [])]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  return {
    appendSystemPrompt,
    additionalSkillPaths: agent.skillPaths ?? [],
    noContextFiles: true,
  };
}

export interface PiAgentAdapterOptions {
  /** Override the model string (otherwise taken from `input.agent.model`). */
  model?: string;
  /**
   * For testing: inject a fake session factory so run() can be exercised
   * without a real model/network. Receives the resolved model + prompt and
   * must return an object implementing {@link PiSessionLike}.
   */
  _sessionFactory?: (args: SessionFactoryArgs) => Promise<PiSessionLike>;
}

export class PiAgentAdapter implements Adapter {
  private readonly model: string | undefined;
  private readonly sessionFactory:
    | ((args: SessionFactoryArgs) => Promise<PiSessionLike>)
    | undefined;

  constructor(options?: PiAgentAdapterOptions) {
    this.model = options?.model;
    this.sessionFactory = options?._sessionFactory;
  }

  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    yield {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "session.status_running",
    } as SessionEvent;

    let session: PiSessionLike | undefined;
    try {
      const rawPrompt = input.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      const prompt = buildPromptWithHistory(rawPrompt, input.history);

      const model = resolveModel(this.model ?? input.agent.model);
      const hasToolExecutor = input.toolExecutor !== undefined;
      const resourceLoaderOptions = buildResourceLoaderOptions(input.agent);

      session = await this.createSession({
        input,
        prompt,
        model,
        hasToolExecutor,
        resourceLoaderOptions,
      });

      const translator = new PiEventTranslator();

      // Bridge the push-based subscribe() into a pull queue. The listener
      // enqueues each SDK event; the async generator below drains it. We
      // complete the queue on `agent_end` (the last event of a run) and on
      // any streamed error event.
      const queue = new EventQueue<AgentSessionEvent>();
      const unsubscribe = session.subscribe((event) => {
        queue.push(event);
        if (event.type === "agent_end") {
          queue.close();
        }
      });

      try {
        // Fire the turn. prompt() resolves once the turn is accepted; output
        // arrives via the subscription. A rejection here (bad model, no auth,
        // ...) is surfaced by closing the queue with the error so it becomes a
        // single session.error rather than an uncaught throw.
        session.prompt(prompt).then(
          () => {
            // If the SDK ever completes prompt() without an agent_end (e.g. an
            // extension command that never starts a turn), don't hang forever.
            queue.closeSoon();
          },
          (error: unknown) => {
            queue.fail(error instanceof Error ? error : new Error(String(error)));
          },
        );

        for await (const event of queue) {
          for (const e of translator.processEvent(event)) yield e;
        }
      } finally {
        unsubscribe();
      }

      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.status_idle",
      } as SessionEvent;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      yield {
        id: generateEventId(),
        timestamp: generateTimestamp(),
        type: "session.error",
        error: { message: msg, code: "pi_agent_error" },
      } as SessionEvent;
    } finally {
      try {
        session?.dispose();
      } catch {
        // dispose() must never mask the real outcome of the run.
      }
    }
  }

  private async createSession(args: SessionFactoryArgs): Promise<PiSessionLike> {
    if (this.sessionFactory) {
      return this.sessionFactory(args);
    }

    // Real SDK path. When a ToolExecutor is injected, disable Pi's own
    // built-in fs/bash tools ("builtin") and register custom tools that proxy
    // into the executor (ADR-0002 §2). When absent, keep Pi's default tools.
    const customTools = args.input.toolExecutor
      ? buildCustomTools(args.input.toolExecutor)
      : undefined;

    // Inject the Host-assembled instructions + equipped Skills per run() via a
    // DefaultResourceLoader (ADR-0002: the Host owns *what* to inject; the
    // Adapter only points the runtime at it). `noContextFiles` keeps Pi from
    // auto-discovering cwd files — instructions come solely from the Host.
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      appendSystemPrompt: args.resourceLoaderOptions.appendSystemPrompt,
      additionalSkillPaths: args.resourceLoaderOptions.additionalSkillPaths,
      noContextFiles: args.resourceLoaderOptions.noContextFiles,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      model: args.model as never,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
      ...(customTools
        ? { customTools, noTools: "builtin" as const }
        : {}),
    });
    return session as PiSessionLike;
  }
}

/**
 * A minimal single-consumer async queue that bridges a push-based listener to
 * a pull-based async iterable. Values pushed before the consumer is ready are
 * buffered; the consumer awaits when the buffer is empty. `close()` ends the
 * iteration cleanly; `fail()` makes the iteration reject; `closeSoon()` closes
 * only if nothing else closes/fails first on the next tick (used as a safety
 * net so a promptless turn cannot hang).
 */
class EventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private rejectors: Array<(error: unknown) => void> = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) {
      this.rejectors.shift();
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      this.rejectors.shift();
      resolve({ value: undefined as never, done: true });
    }
  }

  /** Close on the next tick unless already closed/failed (safety net). */
  closeSoon(): void {
    setTimeout(() => this.close(), 0);
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    while (this.rejectors.length > 0) {
      const reject = this.rejectors.shift()!;
      this.resolvers.shift();
      reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.error !== undefined) {
          const err = this.error;
          this.error = undefined;
          return Promise.reject(err);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push(resolve);
          this.rejectors.push(reject);
        });
      },
    };
  }
}
