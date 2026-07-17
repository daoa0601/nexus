import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { SecretValue } from "../src/config/secret.js";
import type { ProviderStreamEvent } from "../src/providers/contract.js";
import { OpenAICompatibleAdapter } from "../src/providers/openai-compatible.js";
import type { ResolvedChatRequest } from "../src/types.js";
import { providerConfig } from "./support.js";

const servers: Server[] = [];

const listenFixture = async (
  listener: RequestListener,
): Promise<{ readonly server: Server; readonly url: string }> => {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const request = (stream: boolean): ResolvedChatRequest => ({
  publicModel: "public-chat",
  model: "configured-model",
  messages: [
    { role: "system", content: "system context" },
    { role: "developer", content: "developer context" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up" },
  ],
  stream,
  temperature: 0.25,
  topP: 0.9,
  maxCompletionTokens: 100,
  stop: ["END"],
});

const attemptContext = (signal = new AbortController().signal) => ({
  requestId: "adapter-request",
  tenantId: "main",
  deadline: Date.now() + 1_000,
  signal,
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("OpenAI-compatible adapter", () => {
  it("preserves all message turns, the concrete model, options, and actual response identity", async () => {
    let capturedBody: unknown;
    let capturedAuthorization: string | undefined;
    const { url } = await listenFixture((incoming, response) => {
      void (async () => {
        capturedBody = await readJson(incoming);
        capturedAuthorization = incoming.headers.authorization;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "chatcmpl-fixture",
            created: 1_700_000_001,
            model: "actual-upstream-model",
            choices: [
              { message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
          }),
        );
      })();
    });
    const adapter = new OpenAICompatibleAdapter(
      providerConfig("fixture", { baseUrl: `${url}/v1` }),
      new SecretValue("provider-key"),
    );

    const result = await adapter.complete(request(false), attemptContext());

    expect(capturedAuthorization).toBe("Bearer provider-key");
    expect(capturedBody).toEqual({
      model: "configured-model",
      messages: request(false).messages,
      stream: false,
      temperature: 0.25,
      top_p: 0.9,
      max_completion_tokens: 100,
      stop: ["END"],
    });
    expect(result).toEqual({
      id: "chatcmpl-fixture",
      created: 1_700_000_001,
      model: "actual-upstream-model",
      content: "fixture answer",
      finishReason: "stop",
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
    });
  });

  it("maps upstream failures without reading or returning raw response bodies", async () => {
    const rawBody = "provider-secret-diagnostic-that-must-not-leak";
    const { url } = await listenFixture((_incoming, response) => {
      response.statusCode = 500;
      response.end(rawBody);
    });
    const adapter = new OpenAICompatibleAdapter(
      providerConfig("fixture", { baseUrl: `${url}/v1` }),
    );

    let failure: unknown;
    try {
      await adapter.complete(request(false), attemptContext());
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      kind: "unavailable",
      retryable: true,
      status: 500,
      message: "Provider is temporarily unavailable",
    });
    expect(String(failure)).not.toContain(rawBody);
  });

  it("normalizes upstream SSE frames and authoritative usage", async () => {
    let capturedBody: unknown;
    const { url } = await listenFixture((incoming, response) => {
      void (async () => {
        capturedBody = await readJson(incoming);
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.write(
          'data: {"id":"chatcmpl-stream","created":1700000002,"model":"actual-stream-model","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        );
        response.write(
          'data: {"id":"chatcmpl-stream","created":1700000002,"model":"actual-stream-model","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        );
        response.write(
          'data: {"id":"chatcmpl-stream","created":1700000002,"model":"actual-stream-model","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        );
        response.write(
          'data: {"id":"chatcmpl-stream","created":1700000002,"model":"actual-stream-model","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
        );
        response.end("data: [DONE]\n\n");
      })();
    });
    const adapter = new OpenAICompatibleAdapter(
      providerConfig("fixture", { baseUrl: `${url}/v1` }),
    );
    const events: ProviderStreamEvent[] = [];

    for await (const event of adapter.stream(request(true), attemptContext())) events.push(event);

    expect(capturedBody).toMatchObject({ model: "configured-model", stream: true });
    expect(events).toEqual([
      {
        type: "start",
        id: "chatcmpl-stream",
        created: 1_700_000_002,
        model: "actual-stream-model",
      },
      { type: "text-delta", text: "hello" },
      { type: "usage", usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 } },
      { type: "end", finishReason: "stop" },
    ]);
  });
});
