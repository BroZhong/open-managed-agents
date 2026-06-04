/**
 * Codex CLI JSONL event types.
 * These model the shape of `codex exec --json` output.
 */

export interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

export interface CodexTurnStarted {
  type: "turn.started";
}

export interface CodexItemStarted {
  type: "item.started";
  item: {
    id: string;
    type: "command_execution" | "agent_message" | "tool_call";
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    name?: string;
    arguments?: string;
  };
}

export interface CodexItemCompleted {
  type: "item.completed";
  item: {
    id: string;
    type: "command_execution" | "agent_message" | "tool_call";
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    text?: string;
    name?: string;
    arguments?: string;
    output?: string;
  };
}

export interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: {
    input_tokens: number;
    cached_input_tokens?: number;
    output_tokens: number;
    reasoning_output_tokens?: number;
  };
}

export interface CodexTurnFailed {
  type: "turn.failed";
  error: {
    message: string;
  };
}

export interface CodexError {
  type: "error";
  message: string;
}

export type CodexCliEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexItemStarted
  | CodexItemCompleted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexError;
