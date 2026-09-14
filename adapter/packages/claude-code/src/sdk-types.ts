/**
 * Synthetic SDK message types for Claude Code streaming output.
 * These model the shape of events from the Claude Code SDK without
 * importing the actual SDK — keeping the translator pure and testable.
 */

export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SdkContentBlockText {
  type: "text";
  id?: string;
}

export interface SdkContentBlockThinking {
  type: "thinking";
  id?: string;
}

export interface SdkContentBlockToolUse {
  type: "tool_use";
  id?: string;
  name?: string;
}

export type SdkContentBlock =
  | SdkContentBlockText
  | SdkContentBlockThinking
  | SdkContentBlockToolUse;

export interface SdkMessageStartMessage {
  type: "message_start";
  message: {
    id: string;
    model: string;
    usage?: SdkUsage;
  };
}

export interface SdkContentBlockStartMessage {
  type: "content_block_start";
  index: number;
  content_block: SdkContentBlock;
}

export interface SdkContentBlockDeltaMessage {
  type: "content_block_delta";
  index: number;
  delta: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

export interface SdkContentBlockStopMessage {
  type: "content_block_stop";
  index: number;
}

export interface SdkMessageDeltaMessage {
  type: "message_delta";
  delta: {
    stop_reason: string;
  };
  usage: {
    output_tokens: number;
  };
}

export interface SdkMessageStopMessage {
  type: "message_stop";
}

export interface SdkToolResultMessage {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type SdkMessage =
  | SdkMessageStartMessage
  | SdkContentBlockStartMessage
  | SdkContentBlockDeltaMessage
  | SdkContentBlockStopMessage
  | SdkMessageDeltaMessage
  | SdkMessageStopMessage
  | SdkToolResultMessage;
