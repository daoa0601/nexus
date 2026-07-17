import {
  ProviderFailure,
  type AttemptContext,
  type ProviderAdapter,
  type ProviderCompletion,
  type ProviderStreamEvent,
} from "./contract.js";
import type { ProviderConfig, ResolvedChatRequest, TokenUsage } from "../types.js";
import type { SecretValue } from "../config/secret.js";

const MAX_UPSTREAM_RESPONSE_BYTES = 10 * 1024 * 1024;

type FetchImplementation = typeof fetch;

interface UnknownRecord {
  readonly [key: string]: unknown;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const decodeUsage = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  if (
    !finiteNonNegativeInteger(promptTokens) ||
    !finiteNonNegativeInteger(completionTokens) ||
    !finiteNonNegativeInteger(totalTokens)
  ) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
};

const mapStatusFailure = (status: number): ProviderFailure => {
  if (status === 429) {
    return new ProviderFailure("rate-limit", "Provider rate limit exceeded", true, { status });
  }
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return new ProviderFailure("unavailable", "Provider is temporarily unavailable", true, {
      status,
    });
  }
  return new ProviderFailure("rejected", "Provider rejected the request", false, { status });
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort and error bodies are intentionally never read.
  }
};

const readBoundedText = async (response: Response, signal: AbortSignal): Promise<string> => {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  try {
    while (true) {
      if (signal.aborted) {
        throw new ProviderFailure("canceled", "Provider request canceled", true);
      }
      const chunk = await reader.read();
      if (chunk.done) {
        result += decoder.decode();
        return result;
      }
      total += chunk.value.byteLength;
      if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
        throw new ProviderFailure("protocol", "Provider response exceeded the size limit", true);
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

const requestBody = (request: ResolvedChatRequest, stream: boolean): UnknownRecord => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.maxCompletionTokens !== undefined)
    body.max_completion_tokens = request.maxCompletionTokens;
  if (request.stop !== undefined) body.stop = request.stop;
  return body;
};

const chatUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

const requestHeaders = (apiKey: SecretValue | undefined, stream: boolean): Headers => {
  const headers = new Headers({
    accept: stream ? "text/event-stream" : "application/json",
    "content-type": "application/json",
  });
  if (apiKey !== undefined) {
    headers.set("authorization", `Bearer ${apiKey.reveal()}`);
  }
  return headers;
};

const fetchFailure = (error: unknown, signal: AbortSignal): ProviderFailure => {
  if (signal.aborted) {
    return new ProviderFailure("canceled", "Provider request canceled", true, { cause: error });
  }
  return new ProviderFailure("unavailable", "Provider transport failed", true, { cause: error });
};

const parseJsonRecord = (text: string): UnknownRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderFailure("protocol", "Provider returned invalid JSON", true, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ProviderFailure("protocol", "Provider returned an invalid response shape", true);
  }
  return parsed;
};

const decodeCompletion = (data: UnknownRecord, requestedModel: string): ProviderCompletion => {
  const choices = data.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(firstChoice) ? firstChoice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== "string") {
    throw new ProviderFailure("protocol", "Provider response did not contain text content", true);
  }
  const id = typeof data.id === "string" ? data.id : `chatcmpl-nexus-${crypto.randomUUID()}`;
  const created = finiteNonNegativeInteger(data.created)
    ? data.created
    : Math.floor(Date.now() / 1000);
  const model =
    typeof data.model === "string" && data.model.length > 0 ? data.model : requestedModel;
  const finishReason =
    isRecord(firstChoice) &&
    (typeof firstChoice.finish_reason === "string" || firstChoice.finish_reason === null)
      ? firstChoice.finish_reason
      : null;
  const usage = decodeUsage(data.usage);
  const common = { id, created, model, content, finishReason };
  return usage === undefined ? common : { ...common, usage };
};

const sseData = async function* (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exhausted = false;
  try {
    while (true) {
      if (signal.aborted) {
        throw new ProviderFailure("canceled", "Provider stream canceled", true);
      }
      const chunk = await reader.read();
      if (chunk.done) {
        exhausted = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_UPSTREAM_RESPONSE_BYTES) {
        throw new ProviderFailure(
          "protocol",
          "Provider stream frame exceeded the size limit",
          true,
        );
      }
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary === null || boundary.index === undefined) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const payload = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (payload !== "") yield payload;
      }
    }
    const payload = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (payload !== "") yield payload;
  } finally {
    if (!exhausted) {
      try {
        await reader.cancel(signal.reason);
      } catch {
        // Cancellation is best effort when the consumer stops before upstream EOF.
      }
    }
    reader.releaseLock();
  }
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly #config: ProviderConfig;
  readonly #apiKey: SecretValue | undefined;
  readonly #fetch: FetchImplementation;

  constructor(
    config: ProviderConfig,
    apiKey?: SecretValue,
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.id = config.id;
    this.#config = config;
    this.#apiKey = apiKey;
    this.#fetch = fetchImplementation;
  }

  async complete(
    request: ResolvedChatRequest,
    context: AttemptContext,
  ): Promise<ProviderCompletion> {
    let response: Response;
    try {
      response = await this.#fetch(chatUrl(this.#config.baseUrl), {
        method: "POST",
        headers: requestHeaders(this.#apiKey, false),
        body: JSON.stringify(requestBody(request, false)),
        signal: context.signal,
      });
    } catch (error) {
      throw fetchFailure(error, context.signal);
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw mapStatusFailure(response.status);
    }
    const text = await readBoundedText(response, context.signal);
    return decodeCompletion(parseJsonRecord(text), request.model);
  }

  async *stream(
    request: ResolvedChatRequest,
    context: AttemptContext,
  ): AsyncIterable<ProviderStreamEvent> {
    let response: Response;
    try {
      response = await this.#fetch(chatUrl(this.#config.baseUrl), {
        method: "POST",
        headers: requestHeaders(this.#apiKey, true),
        body: JSON.stringify(requestBody(request, true)),
        signal: context.signal,
      });
    } catch (error) {
      throw fetchFailure(error, context.signal);
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw mapStatusFailure(response.status);
    }
    if (response.body === null) {
      throw new ProviderFailure("protocol", "Provider stream did not contain a body", true);
    }

    let started = false;
    let finishReason: string | null = null;
    for await (const payload of sseData(response.body, context.signal)) {
      if (payload === "[DONE]") {
        yield { type: "end", finishReason };
        return;
      }
      const data = parseJsonRecord(payload);
      const choices = data.choices;
      const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
      if (!started) {
        started = true;
        yield {
          type: "start",
          id: typeof data.id === "string" ? data.id : `chatcmpl-nexus-${crypto.randomUUID()}`,
          created: finiteNonNegativeInteger(data.created)
            ? data.created
            : Math.floor(Date.now() / 1000),
          model:
            typeof data.model === "string" && data.model.length > 0 ? data.model : request.model,
        };
      }
      if (
        isRecord(firstChoice) &&
        isRecord(firstChoice.delta) &&
        typeof firstChoice.delta.content === "string"
      ) {
        yield { type: "text-delta", text: firstChoice.delta.content };
      }
      const usage = decodeUsage(data.usage);
      if (usage !== undefined) yield { type: "usage", usage };
      if (
        isRecord(firstChoice) &&
        (typeof firstChoice.finish_reason === "string" || firstChoice.finish_reason === null) &&
        firstChoice.finish_reason !== null
      ) {
        finishReason = firstChoice.finish_reason;
      }
    }
    if (!started) {
      yield {
        type: "start",
        id: `chatcmpl-nexus-${crypto.randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: request.model,
      };
    }
    yield { type: "end", finishReason };
  }

  async close(): Promise<void> {
    // fetch owns no adapter-specific resource.
  }
}
