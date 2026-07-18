import { request as makeHttpRequest } from "node:http";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ProviderFailure } from "../src/providers/contract.js";
import { createNexusServer, type NexusServer } from "../src/server/app.js";
import type {
  ModelAliasConfig,
  NexusConfig,
  TenantConfig,
  TokenReferenceConfig,
} from "../src/types.js";
import {
  completion,
  eventually,
  FakeAdapter,
  loadedConfig,
  nexusConfig,
  providerConfig,
  waitForAbort,
} from "./support.js";

const runningServers: NexusServer[] = [];

const startServer = async (
  adapter: FakeAdapter,
  options: {
    readonly models?: ReadonlyArray<ModelAliasConfig>;
    readonly server?: Partial<NexusConfig["server"]>;
    readonly tenants?: ReadonlyArray<TenantConfig>;
    readonly tokens?: ReadonlyArray<TokenReferenceConfig>;
    readonly inbound?: Readonly<Record<string, string>>;
  } = {},
): Promise<NexusServer> => {
  const config = nexusConfig({
    providers: [providerConfig(adapter.id)],
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.server === undefined ? {} : { server: options.server }),
    ...(options.tenants === undefined ? {} : { tenants: options.tenants }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  });
  const server = createNexusServer({
    loadedConfig: loadedConfig(config, options.inbound),
    adapters: new Map([[adapter.id, adapter]]),
  });
  runningServers.push(server);
  await server.listen();
  return server;
};

const serverUrl = (server: NexusServer): string => {
  if (server.url === undefined) throw new Error("Test server did not expose an address");
  return server.url;
};

const rawHttpExchange = (server: NexusServer, payload: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const address = server.address;
    if (address === undefined) {
      reject(new Error("Test server did not expose an address"));
      return;
    }
    const socket = connect({ host: "127.0.0.1", port: address.port });
    let response = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) reject(new Error("Raw HTTP exchange did not close"));
    }, 1_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", finish);
    socket.once("connect", () => socket.end(payload));
  });

const postChat = (
  server: NexusServer,
  body: unknown,
  token = "test-bearer-token",
  signal?: AbortSignal,
): Promise<Response> =>
  fetch(`${serverUrl(server)}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

afterEach(async () => {
  await Promise.allSettled(runningServers.splice(0).map((server) => server.close()));
});

describe("Nexus HTTP server", () => {
  it("serves health, authenticates every v1 route, and lists only authorized public aliases", async () => {
    const models: ReadonlyArray<ModelAliasConfig> = [
      {
        alias: "public-chat",
        targets: [{ providerId: "fixture", model: "public-target" }],
        equivalentTargets: false,
        routing: { mode: "fallback" },
      },
      {
        alias: "restricted-chat",
        targets: [{ providerId: "fixture", model: "restricted-target" }],
        equivalentTargets: false,
        routing: { mode: "fallback" },
      },
    ];
    const server = await startServer(new FakeAdapter("fixture"), {
      models,
      tenants: [
        { id: "main", allowedModels: ["public-chat"] },
        { id: "restricted", allowedModels: ["restricted-chat"] },
      ],
      tokens: [
        { id: "main-token", tenantId: "main", secretEnv: "MAIN_TOKEN" },
        { id: "restricted-token", tenantId: "restricted", secretEnv: "RESTRICTED_TOKEN" },
      ],
      inbound: { "main-token": "main-secret", "restricted-token": "restricted-secret" },
    });
    const url = serverUrl(server);

    const live = await fetch(`${url}/health/live`);
    const ready = await fetch(`${url}/health/ready`);
    expect(await live.json()).toEqual({ status: "ok", live: true });
    expect(await ready.json()).toEqual({ status: "ok", ready: true });

    const unauthenticatedModels = await fetch(`${url}/v1/models`);
    expect(unauthenticatedModels.status).toBe(401);
    expect(unauthenticatedModels.headers.get("www-authenticate")).toBe("Bearer");

    const unauthenticatedUnknown = await fetch(`${url}/v1/not-a-route`);
    expect(unauthenticatedUnknown.status).toBe(401);
    const authenticatedUnknown = await fetch(`${url}/v1/not-a-route`, {
      headers: { authorization: "Bearer main-secret" },
    });
    expect(authenticatedUnknown.status).toBe(404);

    const modelsResponse = await fetch(`${url}/v1/models`, {
      headers: { authorization: "Bearer main-secret", "x-request-id": "models-request" },
    });
    expect(modelsResponse.headers.get("x-request-id")).toBe("models-request");
    expect(await modelsResponse.json()).toEqual({
      object: "list",
      data: [
        {
          id: "public-chat",
          object: "model",
          created: 0,
          owned_by: "nexus",
          capabilities: ["chat.completions", "streaming"],
        },
      ],
    });
  });

  it("enforces authorization and request limits before returning a mapped JSON completion", async () => {
    const rawDiagnostic = "raw-provider-body-and-secret";
    const adapter = new FakeAdapter("fixture", {
      complete: async (request) => {
        if (request.messages.at(-1)?.content === "cause failure") throw new Error(rawDiagnostic);
        return completion("actual-provider-model", "mapped answer");
      },
    });
    const models: ReadonlyArray<ModelAliasConfig> = [
      {
        alias: "public-chat",
        targets: [{ providerId: "fixture", model: "configured-target" }],
        equivalentTargets: false,
        routing: { mode: "fallback" },
      },
      {
        alias: "forbidden-chat",
        targets: [{ providerId: "fixture", model: "forbidden-target" }],
        equivalentTargets: false,
        routing: { mode: "fallback" },
      },
    ];
    const server = await startServer(adapter, {
      models,
      tenants: [
        { id: "main", allowedModels: ["public-chat"] },
        { id: "other", allowedModels: ["forbidden-chat"] },
      ],
      tokens: [
        { id: "main-token", tenantId: "main", secretEnv: "MAIN_TOKEN" },
        { id: "other-token", tenantId: "other", secretEnv: "OTHER_TOKEN" },
      ],
      inbound: { "main-token": "main-secret", "other-token": "other-secret" },
      server: { bodyLimitBytes: 1_024, maxContentChars: 80 },
    });

    const forbidden = await postChat(
      server,
      { model: "forbidden-chat", messages: [{ role: "user", content: "hello" }] },
      "main-secret",
    );
    expect(forbidden.status).toBe(403);

    const unsupported = await postChat(
      server,
      { model: "public-chat", messages: [{ role: "user", content: "hello" }], tools: [] },
      "main-secret",
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const excessiveContent = await postChat(
      server,
      { model: "public-chat", messages: [{ role: "user", content: "x".repeat(81) }] },
      "main-secret",
    );
    expect(excessiveContent.status).toBe(400);

    const excessiveBody = await postChat(
      server,
      { model: "public-chat", messages: [{ role: "user", content: "x".repeat(2_000) }] },
      "main-secret",
    );
    expect(excessiveBody.status).toBe(400);

    const completed = await postChat(
      server,
      {
        model: "public-chat",
        messages: [
          { role: "system", content: "rules" },
          { role: "developer", content: "implementation rules" },
          { role: "user", content: "hello" },
        ],
      },
      "main-secret",
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      object: "chat.completion",
      model: "actual-provider-model",
      choices: [
        { message: { role: "assistant", content: "mapped answer" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      nexus: {
        public_model: "public-chat",
        provider: "fixture",
        target_model: "configured-target",
      },
    });

    const failed = await postChat(
      server,
      { model: "public-chat", messages: [{ role: "user", content: "cause failure" }] },
      "main-secret",
    );
    const failedText = await failed.text();
    expect(failed.status).toBe(503);
    expect(failedText).toContain("UPSTREAM_UNAVAILABLE");
    expect(failedText).not.toContain(rawDiagnostic);
  });

  it("frames streaming chunks and terminates with data: [DONE]", async () => {
    const adapter = new FakeAdapter("fixture", {
      stream: async function* (request) {
        yield {
          type: "start",
          id: "chatcmpl-stream",
          created: 1_700_000_003,
          model: request.model,
        };
        yield { type: "text-delta", text: "hello " };
        yield { type: "text-delta", text: "world" };
        yield { type: "usage", usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 } };
        yield { type: "end", finishReason: "stop" };
      },
    });
    const server = await startServer(adapter);
    const response = await postChat(server, {
      model: "public-chat",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"content":"hello "');
    expect(text).toContain('"content":"world"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"prompt_tokens":2');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(server.ledger.snapshot().map(({ outcome }) => outcome)).toEqual(["success"]);
  });

  it("propagates a client disconnect and leaves no pending attempt", async () => {
    let upstreamAborted = false;
    const adapter = new FakeAdapter("fixture", {
      stream: async function* (request, attemptContext) {
        yield { type: "start", id: "disconnect-stream", created: 1, model: request.model };
        yield { type: "text-delta", text: "first" };
        try {
          await waitForAbort(attemptContext.signal);
        } finally {
          upstreamAborted = attemptContext.signal.aborted;
        }
      },
    });
    const server = await startServer(adapter, { server: { requestTimeoutMs: 2_000 } });
    const controller = new AbortController();
    const response = await postChat(
      server,
      { model: "public-chat", messages: [{ role: "user", content: "hello" }], stream: true },
      "test-bearer-token",
      controller.signal,
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    controller.abort();
    try {
      await reader?.read();
    } catch {
      // Aborted fetch bodies reject as expected.
    }

    await eventually(() => upstreamAborted);
    await eventually(() => server.ledger.snapshot().every(({ outcome }) => outcome !== "pending"));
    expect(server.ledger.snapshot().map(({ outcome }) => outcome)).toEqual(["canceled"]);
  });

  it("gracefully closes adapters, cancels active work, and terminalizes the ledger", async () => {
    let adapterClosed = false;
    let shutdownObserved = false;
    const adapter = new FakeAdapter("fixture", {
      stream: async function* (request, attemptContext) {
        yield { type: "start", id: "shutdown-stream", created: 1, model: request.model };
        yield { type: "text-delta", text: "first" };
        try {
          await waitForAbort(attemptContext.signal);
        } finally {
          shutdownObserved = attemptContext.signal.aborted;
        }
      },
      close: async () => {
        adapterClosed = true;
      },
    });
    const server = await startServer(adapter, {
      server: { requestTimeoutMs: 2_000, shutdownGraceMs: 200 },
    });
    const response = await postChat(server, {
      model: "public-chat",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const reader = response.body?.getReader();
    await reader?.read();

    await server.close();
    try {
      await reader?.read();
    } catch {
      // Graceful shutdown closes the in-flight downstream response.
    }

    expect(adapterClosed).toBe(true);
    expect(shutdownObserved).toBe(true);
    expect(server.ledger.snapshot().map(({ outcome }) => outcome)).toEqual(["canceled"]);
  });

  it("enforces the global request concurrency cap", async () => {
    let active = false;
    let releaseRequest: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const adapter = new FakeAdapter("fixture", {
      complete: async (request, attemptContext) => {
        active = true;
        await Promise.race([blocked, waitForAbort(attemptContext.signal)]);
        return completion(request.model);
      },
    });
    const server = await startServer(adapter, {
      server: { maxConcurrentRequests: 1, requestTimeoutMs: 2_000 },
    });
    const first = postChat(server, {
      model: "public-chat",
      messages: [{ role: "user", content: "hold" }],
    });
    await eventually(() => active);

    const saturated = await fetch(`${serverUrl(server)}/v1/models`, {
      headers: { authorization: "Bearer test-bearer-token" },
    });
    expect(saturated.status).toBe(429);
    expect(await saturated.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

    releaseRequest?.();
    expect((await first).status).toBe(200);
  });

  it("bounds a stalled request body with the same root deadline", async () => {
    const server = await startServer(new FakeAdapter("fixture"), {
      server: { requestTimeoutMs: 80 },
    });
    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(testTimer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const request = makeHttpRequest(
        `${serverUrl(server)}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-bearer-token",
            "content-type": "application/json",
            "content-length": "200",
          },
        },
        (response) => {
          response.resume();
          response.once("close", () => finish());
        },
      );
      const testTimer = setTimeout(() => {
        request.destroy();
        finish(new Error("Stalled request was not bounded by the root deadline"));
      }, 500);
      request.once("error", () => finish());
      request.once("close", () => finish());
      request.write('{"model":"public');
    });

    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(server.ledger.snapshot()).toEqual([]);
    const closeStartedAt = Date.now();
    await server.close();
    expect(Date.now() - closeStartedAt).toBeLessThan(300);
  });

  it("rejects stacked transfer codings but accepts ordinary chunked JSON", async () => {
    const server = await startServer(new FakeAdapter("fixture"));
    const chatBody = JSON.stringify({
      model: "public-chat",
      messages: [{ role: "user", content: "hello" }],
    });
    const headers = [
      "POST /v1/chat/completions HTTP/1.1",
      "Host: nexus.local",
      "Authorization: Bearer test-bearer-token",
      "Content-Type: application/json",
      "Connection: close",
    ];
    const unsupported = await rawHttpExchange(
      server,
      [
        ...headers,
        "Transfer-Encoding: gzip, chunked",
        "",
        chatBody.length.toString(16),
        chatBody,
        "0",
        "",
        "",
      ].join("\r\n"),
    );
    expect(unsupported).toMatch(/^HTTP\/1\.1 400/u);
    expect(unsupported).toContain("INVALID_REQUEST");

    const chunked = await rawHttpExchange(
      server,
      [
        ...headers,
        "Transfer-Encoding: chunked",
        "",
        chatBody.length.toString(16),
        chatBody,
        "0",
        "",
        "",
      ].join("\r\n"),
    );
    expect(chunked).toMatch(/^HTTP\/1\.1 200/u);
    expect(chunked).toContain("chat.completion");
  });

  it("returns stable request IDs and redacted errors for malformed request IDs", async () => {
    const server = await startServer(
      new FakeAdapter("fixture", {
        complete: async () => {
          throw new ProviderFailure("unavailable", "controlled provider failure", true);
        },
      }),
    );
    const response = await fetch(`${serverUrl(server)}/v1/models`, {
      headers: { authorization: "Bearer test-bearer-token", "x-request-id": "contains spaces" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(body.request_id).toBe(response.headers.get("x-request-id"));
  });
});
