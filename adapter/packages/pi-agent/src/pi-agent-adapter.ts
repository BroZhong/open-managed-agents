import {
  createAgentSession,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  PromptOptions,
  Skill,
} from "@earendil-works/pi-coding-agent";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
  SkillDescriptor,
} from "@open-managed-agents/adapter-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import { buildCustomTools } from "./custom-tools.js";
import { eventLogToAgentMessages } from "./event-log-to-messages.js";
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
  /**
   * Pi's native "Abort current operation and wait for agent to become idle"
   * (issue #84). We call it when `input.signal` fires so a user interrupt can
   * unwedge a turn whose tool exec never returns: aborting settles `prompt()`,
   * which closes the EventQueue and lets the `for await` end naturally. This is
   * a pure reuse of Pi's own cancel — no timeout/watchdog is introduced.
   */
  abort(): Promise<void> | void;
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
  /** Equipped-Skill root directories the Host provides (`additionalSkillPaths`). */
  additionalSkillPaths: string[];
  /** Host-resolved metadata for Skills projected inside the sandbox. */
  skillDescriptors: SkillDescriptor[];
  /** Host owns instructions; never auto-discover cwd context files. */
  noContextFiles: true;
}

/** Everything the adapter needs to spin up a Pi session for one run(). */
export interface SessionFactoryArgs {
  input: AdapterInput;
  /**
   * The current turn's user prompt text ONLY. Prior turns are no longer
   * flattened into this string (ADR-0003) — they are rebuilt as structured
   * {@link SessionFactoryArgs.historyMessages} and seeded into the session.
   */
  prompt: string;
  /**
   * Structured conversation history rebuilt from `input.history` via
   * {@link eventLogToAgentMessages} (ADR-0003). The real SDK path seeds these
   * into an in-memory `SessionManager` (via `appendMessage`) before
   * `createAgentSession`, so prior text / tool calls / tool results are in the
   * model's context on the first `prompt()`. Empty for the first turn.
   */
  historyMessages: Message[];
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
    skillDescriptors: agent.skillDescriptors ?? [],
    noContextFiles: true,
  };
}

/**
 * Build the `<available_skills>` system-prompt section for the equipped Skills.
 *
 * Pi's own system-prompt builder only emits this section when a builtin tool
 * named `read` is selected. This adapter runs with `noTools: "builtin"` (no
 * builtin tools are selected) and its own custom Host-executor tools, so that
 * gate is never satisfied and the model is never told its equipped Skills exist
 * — even though the Host provided their paths. We therefore assemble the section
 * ourselves from the loaded Skills and append it to the Host-owned system
 * prompt. Our custom tools use Pi's native factories, so the read tool is named
 * `read` — matching Pi's "Use the read tool to load a skill's file" wording
 * verbatim, so no rewrite is needed.
 *
 * Returns `""` when there are no model-invocable Skills.
 */
export function buildSkillsPromptSection(descriptors: SkillDescriptor[]): string {
  const skills = descriptors.map(
    ({ name, description, path }): Skill => ({
      name,
      description,
      filePath: path,
      disableModelInvocation: false,
    }) as Skill,
  );
  return formatSkillsForPrompt(skills) || "";
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
    // The router is the sole owner of session.status_running/idle (issue #83):
    // it knows the whole drain-wave boundary, while this adapter sees only one
    // turn. Emitting them here too doubled every turn's lifecycle events. The
    // adapter now yields only real content/errors.
    let session: PiSessionLike | undefined;
    try {
      const prompt = input.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");

      // Rebuild structured history from the event log (ADR-0003). Prior turns —
      // text, tool calls, and tool results — are replayed into the session so
      // they survive into the model's context via the Pi provider layer, rather
      // than being flattened into the prompt string. Empty on the first turn.
      const historyMessages = eventLogToAgentMessages(input.history);

      const model = resolveModel(this.model ?? input.agent.model);
      const hasToolExecutor = input.toolExecutor !== undefined;
      const resourceLoaderOptions = buildResourceLoaderOptions(input.agent);

      session = await this.createSession({
        input,
        prompt,
        historyMessages,
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

      // Wire the router's per-turn abort signal to Pi's native cancel (issue
      // #84). Without this, a hung turn (a tool exec that never returns, so
      // prompt() never settles and no further event arrives) locks the session
      // forever — the drain loop only re-checks `aborted` when the next event
      // comes. Calling `session.abort()` settles prompt(), which closes the
      // EventQueue above, so the `for await` ends naturally. We reuse Pi's own
      // cancel rather than inventing a watchdog. Wired AFTER subscribe() so an
      // abort's resulting agent_end reaches the queue. If the signal already
      // fired, abort immediately; otherwise register a one-shot listener removed
      // in the finally so a completed turn leaves nothing attached.
      const signal = input.signal;
      const activeSession = session;
      const onAbort = () => {
        void activeSession.abort();
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

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
        if (signal) signal.removeEventListener("abort", onAbort);
      }
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

    const agentDir = getAgentDir();
    const cwd = process.cwd();
    const skillPaths = args.resourceLoaderOptions.additionalSkillPaths;
    const skillDescriptors = args.resourceLoaderOptions.skillDescriptors;

    // Pi only injects the `<available_skills>` prompt section when a builtin
    // `read` tool is selected; with custom tools + `noTools: "builtin"` that
    // gate never fires, so the equipped Skills would be invisible to the model even
    // though the Host provided their paths. When we run custom tools, assemble the
    // section ourselves from Host-resolved metadata and fold it into the
    // Host-owned appendSystemPrompt, then pass `noSkills` so Pi does not also
    // try (and skip) its own gated injection (see buildSkillsPromptSection).
    let appendSystemPrompt = args.resourceLoaderOptions.appendSystemPrompt;
    if (customTools && skillPaths.length > 0 && skillDescriptors.length === 0) {
      throw new Error(
        "Custom-tool Skill injection requires agent.skillDescriptors; " +
        "sandbox skillPaths cannot be loaded from the Host",
      );
    }
    const injectSkillsIntoPrompt = Boolean(customTools) && skillDescriptors.length > 0;
    if (injectSkillsIntoPrompt) {
      const skillsSection = buildSkillsPromptSection(skillDescriptors);
      if (skillsSection) {
        appendSystemPrompt = [...appendSystemPrompt, skillsSection];
      }
    }

    // Inject the Host-assembled instructions + equipped Skills per run() via a
    // DefaultResourceLoader (ADR-0002: the Host owns *what* to inject; the
    // Adapter only points the runtime at it). `noContextFiles` keeps Pi from
    // auto-discovering cwd files — instructions come solely from the Host.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      appendSystemPrompt,
      // When we inject the skills section ourselves (custom-tool path), skip
      // Pi's own skill loading so the section is not duplicated / re-gated.
      ...(injectSkillsIntoPrompt
        ? { noSkills: true }
        : { additionalSkillPaths: skillPaths }),
      noContextFiles: args.resourceLoaderOptions.noContextFiles,
    });
    await resourceLoader.reload();

    // Seed the rebuilt structured history into an in-memory SessionManager
    // (ADR-0003 §2). `appendMessage` auto-generates entry ids/parentId, so we
    // build no tree by hand; `createAgentSession` calls `buildSessionContext()`
    // at construction, loading this history into the LLM context before the
    // first `prompt()`. `persist = false`, so nothing is written to disk — the
    // event log stays the sole authoritative store.
    const sessionManager = SessionManager.inMemory();
    for (const message of args.historyMessages) {
      sessionManager.appendMessage(message);
    }

    const { session } = await createAgentSession({
      model: args.model as never,
      sessionManager,
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
