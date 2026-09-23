import type { Http } from "./http.js";
export type Values = Record<string, any>;
export type Flag = {
  type: "string" | "boolean" | "integer" | "duration" | "json";
  description: string;
  required?: boolean;
  default?: any;
  enum?: readonly string[];
  min?: number;
  max?: number;
  field?: string;
  source?: "text-file";
  requires?: string[];
  repeat?: boolean;
};
export type Result = {
  data: unknown;
  meta?: Values;
  ok?: boolean;
  raw?: string;
  code?: number;
  silent?: boolean;
};
export type Context = {
  flags: Values;
  body: Values;
  http: Http;
  signal: AbortSignal;
  command: Command;
  write: (s: string) => void;
};
export type Step = {
  method: string;
  path: string;
  body?: unknown;
  effects?: string;
  output?: string;
};
export type Command = {
  path: string;
  description: string;
  flags: Record<string, Flag>;
  bodyFields?: Record<string, Flag>;
  requiredBody?: string[];
  exclusive?: string[][];
  effects?: string;
  api?: string[];
  output?: string;
  examples?: string[];
  dependencies?: string[];
  write?: boolean;
  confirm?: boolean;
  offline?: boolean;
  validate?: (flags: Values, body: Values) => void;
  run: (c: Context) => Promise<Result>;
};
export const string = (
  description: string,
  extra: Partial<Flag> = {},
): Flag => ({ type: "string", description, ...extra });
export const boolean = (
  description: string,
  extra: Partial<Flag> = {},
): Flag => ({ type: "boolean", description, default: false, ...extra });
export const id = (noun: string): Record<string, Flag> => ({
  [`${noun}-id`]: string(`Explicit ${noun} ID`, { required: true }),
});
export const pagination: Record<string, Flag> = {
  limit: {
    type: "integer",
    description: "Page size",
    default: 50,
    min: 1,
    max: 100,
  },
  cursor: string("Starting cursor"),
  all: boolean("Read remaining pages (not a snapshot)"),
};
