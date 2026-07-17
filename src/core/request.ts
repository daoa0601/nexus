import { NexusError } from "../errors.js";
import type { ChatMessage, ChatRequest, MessageRole, ServerLimits } from "../types.js";

type UnknownRecord = Record<string, unknown>;

const fail = (message: string): never => {
  throw new NexusError("INVALID_REQUEST", message);
};

const asRecord = (value: unknown, path: string): UnknownRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  return value as UnknownRecord;
};

const exactKeys = (record: UnknownRecord, path: string, allowed: ReadonlyArray<string>): void => {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    fail(
      `${path} contains unsupported ${unknown.length === 1 ? "field" : "fields"}: ${unknown.sort().join(", ")}`,
    );
  }
};

const optionalNumber = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return fail(`${path} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
};

const optionalInteger = (value: unknown, path: string, maximum: number): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return fail(`${path} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
};

const decodeMessage = (value: unknown, index: number): ChatMessage => {
  const path = `messages[${index}]`;
  const record = asRecord(value, path);
  exactKeys(record, path, ["role", "content"]);
  const rawRole = record.role;
  const roles: ReadonlyArray<MessageRole> = ["system", "developer", "user", "assistant"];
  const role =
    typeof rawRole === "string" && roles.includes(rawRole as MessageRole)
      ? (rawRole as MessageRole)
      : fail(`${path}.role must be system, developer, user, or assistant`);
  const content =
    typeof record.content === "string" ? record.content : fail(`${path}.content must be a string`);
  return { role: role as MessageRole, content };
};

const decodeStop = (value: unknown): string | ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length === 0 || value.length > 256) fail("stop must contain 1 to 256 characters");
    return value;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    return fail("stop must be a string or an array of 1 to 4 strings");
  }
  const stops = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
      fail(`stop[${index}] must contain 1 to 256 characters`);
    }
    return entry as string;
  });
  return Object.freeze(stops);
};

export const decodeChatRequest = (value: unknown, limits: ServerLimits): ChatRequest => {
  const record = asRecord(value, "request");
  exactKeys(record, "request", [
    "model",
    "messages",
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "stop",
  ]);
  const rawModel = record.model;
  const model =
    typeof rawModel === "string" && rawModel.length > 0 && rawModel.length <= 128
      ? rawModel
      : fail("model must be a non-empty string of at most 128 characters");
  const rawMessages =
    Array.isArray(record.messages) && record.messages.length > 0
      ? record.messages
      : fail("messages must be a non-empty array");
  if (rawMessages.length > limits.maxMessages) {
    fail(`messages exceeds the configured limit of ${limits.maxMessages}`);
  }
  const messages = rawMessages.map(decodeMessage);
  const totalContentChars = messages.reduce((total, message) => total + message.content.length, 0);
  if (totalContentChars > limits.maxContentChars) {
    fail(`message content exceeds the configured limit of ${limits.maxContentChars} characters`);
  }
  if (record.stream !== undefined && typeof record.stream !== "boolean") {
    fail("stream must be a boolean");
  }
  const maxTokens = optionalInteger(record.max_tokens, "max_tokens", limits.maxOutputTokens);
  const requestedMaxCompletionTokens = optionalInteger(
    record.max_completion_tokens,
    "max_completion_tokens",
    limits.maxOutputTokens,
  );
  if (maxTokens !== undefined && requestedMaxCompletionTokens !== undefined) {
    fail("max_tokens and max_completion_tokens are mutually exclusive");
  }
  const maxCompletionTokens =
    maxTokens === undefined ? (requestedMaxCompletionTokens ?? limits.maxOutputTokens) : undefined;
  const temperature = optionalNumber(record.temperature, "temperature", 0, 2);
  const topP = optionalNumber(record.top_p, "top_p", 0, 1);
  const stop = decodeStop(record.stop);
  return Object.freeze({
    model,
    messages: Object.freeze(messages),
    stream: record.stream === true,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
    ...(stop === undefined ? {} : { stop }),
  });
};
