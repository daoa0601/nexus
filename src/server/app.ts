import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { LoadedConfig } from "../config/load.js";
import { ConcurrencyGate, type Release } from "../core/concurrency.js";
import { createNexusGateway, NexusGateway } from "../core/gateway.js";
import { decodeChatRequest } from "../core/request.js";
import {
  ClientDisconnectReason,
  DeadlineAbortReason,
  errorEnvelope,
  NexusError,
  ShutdownAbortReason,
  toNexusError,
} from "../errors.js";
import type { ProviderAdapter } from "../providers/contract.js";
import { TokenAuthenticator } from "../security/auth.js";
import { writeSseData } from "../streaming/sse.js";
import { AttemptLedger } from "../telemetry/ledger.js";
import type {
  AuthenticatedTenant,
  ChatCompletionResponse,
  ChatRequest,
  RoutedStreamEvent,
  TokenUsage,
} from "../types.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const setCommonHeaders = (response: ServerResponse, requestId: string): void => {
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void => {
  if (response.headersSent || response.destroyed) return;
  setCommonHeaders(response, requestId);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
};

const readJsonBody = async (
  request: IncomingMessage,
  byteLimit: number,
  signal: AbortSignal,
): Promise<unknown> => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new NexusError("INVALID_REQUEST", "Content-Type must be application/json");
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > byteLimit) {
      throw new NexusError(
        "INVALID_REQUEST",
        `Request body exceeds the configured limit of ${byteLimit} bytes`,
      );
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => {
    request.destroy(signal.reason instanceof Error ? signal.reason : new ClientDisconnectReason());
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw signal.reason;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > byteLimit) {
        throw new NexusError(
          "INVALID_REQUEST",
          `Request body exceeds the configured limit of ${byteLimit} bytes`,
        );
      }
      chunks.push(buffer);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw signal.reason;
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new NexusError("INVALID_REQUEST", "Request body must contain valid JSON");
  }
};

const usageResponse = (usage: TokenUsage) => ({
  prompt_tokens: usage.promptTokens,
  completion_tokens: usage.completionTokens,
  total_tokens: usage.totalTokens,
});

const completionResponse = (
  request: ChatRequest,
  requestId: string,
  routed: Awaited<ReturnType<NexusGateway["complete"]>>,
): ChatCompletionResponse => {
  const completion = routed.completion;
  const common = {
    id: completion.id,
    object: "chat.completion" as const,
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0 as const,
        message: { role: "assistant" as const, content: completion.content },
        finish_reason: completion.finishReason,
      },
    ],
    nexus: {
      request_id: requestId,
      public_model: request.model,
      provider: routed.providerId,
      target_model: routed.targetModel,
    },
  };
  return completion.usage === undefined
    ? common
    : { ...common, usage: usageResponse(completion.usage) };
};

interface StreamState {
  id: string;
  created: number;
  model: string;
  providerId: string;
  targetModel: string;
  usage?: TokenUsage;
}

const chunkForEvent = (
  event: RoutedStreamEvent,
  state: StreamState,
  requestId: string,
  publicModel: string,
) => {
  if (event.type === "start") {
    state.id = event.id;
    state.created = event.created;
    state.model = event.model;
    state.providerId = event.providerId;
    state.targetModel = event.targetModel;
    return {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      nexus: {
        request_id: requestId,
        public_model: publicModel,
        provider: state.providerId,
        target_model: state.targetModel,
      },
    };
  }
  if (event.type === "text-delta") {
    return {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
    };
  }
  if (event.type === "usage") {
    state.usage = event.usage;
    return undefined;
  }
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
    ...(state.usage === undefined ? {} : { usage: usageResponse(state.usage) }),
  };
};

export interface NexusServerOptions {
  readonly loadedConfig: LoadedConfig;
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>;
  readonly ledger?: AttemptLedger;
}

export class NexusServer {
  readonly config: LoadedConfig["config"];
  readonly gateway: NexusGateway;
  readonly ledger: AttemptLedger;
  readonly #authenticator: TokenAuthenticator;
  readonly #admission: ConcurrencyGate;
  readonly #server: Server;
  readonly #activeControllers = new Set<AbortController>();
  #listening = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: NexusServerOptions) {
    this.config = options.loadedConfig.config;
    this.ledger = options.ledger ?? new AttemptLedger();
    this.#authenticator = new TokenAuthenticator(this.config, options.loadedConfig.secrets);
    this.#admission = new ConcurrencyGate(this.config.server.maxConcurrentRequests);
    this.gateway = createNexusGateway({
      config: this.config,
      secrets: options.loadedConfig.secrets,
      ledger: this.ledger,
      ...(options.adapters === undefined ? {} : { adapters: options.adapters }),
    });
    this.#server = createServer((request, response) => {
      void this.#dispatch(request, response);
    });
    this.#server.requestTimeout = 0;
    this.#server.headersTimeout = Math.min(this.config.server.requestTimeoutMs, 60_000);
    this.#server.keepAliveTimeout = 5_000;
  }

  get address(): AddressInfo | undefined {
    const address = this.#server.address();
    return typeof address === "object" && address !== null ? address : undefined;
  }

  get url(): string | undefined {
    const address = this.address;
    if (address === undefined) return undefined;
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  async listen(): Promise<void> {
    if (this.#closing) throw new NexusError("SERVER_SHUTTING_DOWN", "Nexus is shutting down");
    if (this.#listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.config.server.port, this.config.server.host);
    });
    this.#listening = true;
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const suppliedRequestId = request.headers["x-request-id"];
    const supplied = Array.isArray(suppliedRequestId) ? undefined : suppliedRequestId;
    const requestId =
      supplied !== undefined && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    const deadline = Date.now() + this.config.server.requestTimeoutMs;
    const timer = setTimeout(
      () => controller.abort(new DeadlineAbortReason()),
      this.config.server.requestTimeoutMs,
    );
    timer.unref();
    const onAborted = (): void => controller.abort(new ClientDisconnectReason());
    const onClosed = (): void => {
      if (!response.writableFinished) controller.abort(new ClientDisconnectReason());
    };
    request.once("aborted", onAborted);
    response.once("close", onClosed);
    let release: Release | undefined;

    try {
      if (supplied !== undefined && !REQUEST_ID_PATTERN.test(supplied)) {
        throw new NexusError("INVALID_REQUEST", "x-request-id contains unsupported characters");
      }
      if (this.#closing) throw new NexusError("SERVER_SHUTTING_DOWN", "Nexus is shutting down");
      const path = new URL(request.url ?? "/", "http://nexus.local").pathname;
      let tenant: AuthenticatedTenant | undefined;
      if (path === "/v1" || path.startsWith("/v1/")) {
        tenant = this.#authenticate(request);
        release = this.#admission.tryAcquire();
        if (release === undefined) {
          throw new NexusError("RATE_LIMITED", "Nexus request concurrency limit reached");
        }
      }
      await this.#handle(request, response, requestId, deadline, controller.signal, path, tenant);
    } catch (error) {
      const normalized =
        controller.signal.reason instanceof DeadlineAbortReason
          ? new NexusError("DEADLINE_EXCEEDED", "The request deadline was exceeded")
          : controller.signal.reason instanceof ShutdownAbortReason
            ? new NexusError("SERVER_SHUTTING_DOWN", "Nexus is shutting down")
            : toNexusError(error);
      if (!response.headersSent) {
        sendJson(
          response,
          normalized.status,
          errorEnvelope(normalized, requestId),
          requestId,
          normalized.code === "AUTHENTICATION_FAILED" ? { "www-authenticate": "Bearer" } : {},
        );
      } else if (
        !response.destroyed &&
        response.getHeader("content-type") === "text/event-stream; charset=utf-8"
      ) {
        try {
          await writeSseData(response, errorEnvelope(normalized, requestId), controller.signal);
          await writeSseData(response, "[DONE]", controller.signal);
          response.end();
        } catch {
          response.destroy();
        }
      }
    } finally {
      release?.();
      clearTimeout(timer);
      request.off("aborted", onAborted);
      response.off("close", onClosed);
      this.#activeControllers.delete(controller);
    }
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    deadline: number,
    signal: AbortSignal,
    path: string,
    tenant: AuthenticatedTenant | undefined,
  ): Promise<void> {
    if (request.method === "GET" && path === "/health/live") {
      sendJson(response, 200, { status: "ok", live: true }, requestId);
      return;
    }
    if (request.method === "GET" && path === "/health/ready") {
      sendJson(response, 200, { status: "ok", ready: true }, requestId);
      return;
    }
    if (request.method === "GET" && path === "/v1/models") {
      if (tenant === undefined)
        throw new NexusError("INTERNAL_ERROR", "Authentication context is missing");
      const data = this.gateway
        .models()
        .filter(({ alias }) => tenant.allowedModels.has(alias))
        .map(({ alias }) => ({
          id: alias,
          object: "model",
          created: 0,
          owned_by: "nexus",
          capabilities: ["chat.completions", "streaming"],
        }));
      sendJson(response, 200, { object: "list", data }, requestId);
      return;
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      if (tenant === undefined)
        throw new NexusError("INTERNAL_ERROR", "Authentication context is missing");
      const body = await readJsonBody(request, this.config.server.bodyLimitBytes, signal);
      const chatRequest = decodeChatRequest(body, this.config.server);
      this.gateway.model(chatRequest.model);
      this.#authenticator.authorizeModel(tenant, chatRequest.model);
      const context = { requestId, tenantId: tenant.tenantId, deadline, signal };
      if (!chatRequest.stream) {
        const routed = await this.gateway.complete(chatRequest, context);
        sendJson(response, 200, completionResponse(chatRequest, requestId, routed), requestId);
        return;
      }
      await this.#stream(response, chatRequest, context);
      return;
    }
    throw new NexusError("NOT_FOUND", "Route not found");
  }

  #authenticate(request: IncomingMessage): AuthenticatedTenant {
    return this.#authenticator.authenticate(request.headers.authorization);
  }

  async #stream(
    response: ServerResponse,
    request: ChatRequest,
    context: {
      readonly requestId: string;
      readonly tenantId: string;
      readonly deadline: number;
      readonly signal: AbortSignal;
    },
  ): Promise<void> {
    const iterator = this.gateway.stream(request, context)[Symbol.asyncIterator]();
    let first: IteratorResult<RoutedStreamEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      await iterator.return?.(undefined);
      throw error;
    }
    setCommonHeaders(response, context.requestId);
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    const state: StreamState = {
      id: `chatcmpl-nexus-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      providerId: "",
      targetModel: "",
    };

    try {
      let current = first;
      while (!current.done) {
        const chunk = chunkForEvent(current.value, state, context.requestId, request.model);
        if (chunk !== undefined) await writeSseData(response, chunk, context.signal);
        current = await iterator.next();
      }
      await writeSseData(response, "[DONE]", context.signal);
      response.end();
    } catch (error) {
      await iterator.return?.(undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      for (const controller of this.#activeControllers) controller.abort(new ShutdownAbortReason());
      if (this.#listening) {
        await new Promise<void>((resolve) => {
          let resolved = false;
          let timer: NodeJS.Timeout | undefined;
          const finish = (): void => {
            if (resolved) return;
            resolved = true;
            if (timer !== undefined) clearTimeout(timer);
            resolve();
          };
          this.#server.close(finish);
          timer = setTimeout(() => {
            this.#server.closeAllConnections();
            finish();
          }, this.config.server.shutdownGraceMs);
          timer.unref();
        });
        this.#listening = false;
      }
      await this.gateway.close();
    })();
    return this.#closePromise;
  }
}

export const createNexusServer = (options: NexusServerOptions): NexusServer =>
  new NexusServer(options);
