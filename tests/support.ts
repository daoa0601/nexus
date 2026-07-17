import type { LoadedConfig } from "../src/config/load.js";
import { SecretValue, type RuntimeSecrets } from "../src/config/secret.js";
import type {
  AttemptContext,
  ProviderAdapter,
  ProviderCompletion,
  ProviderStreamEvent,
} from "../src/providers/contract.js";
import type {
  ChatRequest,
  ModelAliasConfig,
  NexusConfig,
  ProviderConfig,
  ResolvedChatRequest,
  TenantConfig,
  TokenReferenceConfig,
} from "../src/types.js";

export const providerConfig = (
  id: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig => ({
  id,
  type: "openai-compatible",
  baseUrl: `http://127.0.0.1:1/${id}`,
  allowLoopbackHttp: true,
  requestTimeoutMs: 200,
  maxConcurrency: 8,
  ...overrides,
});

interface ConfigOptions {
  readonly providers?: ReadonlyArray<ProviderConfig>;
  readonly models?: ReadonlyArray<ModelAliasConfig>;
  readonly tenants?: ReadonlyArray<TenantConfig>;
  readonly tokens?: ReadonlyArray<TokenReferenceConfig>;
  readonly server?: Partial<NexusConfig["server"]>;
}

export const nexusConfig = (options: ConfigOptions = {}): NexusConfig => {
  const providers = options.providers ?? [providerConfig("primary")];
  const models = options.models ?? [
    {
      alias: "public-chat",
      targets: [{ providerId: providers[0]?.id ?? "primary", model: "concrete-chat" }],
      equivalentTargets: false,
      routing: { mode: "fallback" },
    },
  ];
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 0,
      requestTimeoutMs: 300,
      bodyLimitBytes: 2_048,
      maxMessages: 8,
      maxContentChars: 512,
      maxOutputTokens: 256,
      maxConcurrentRequests: 8,
      shutdownGraceMs: 100,
      ...options.server,
    },
    auth: {
      tokens: options.tokens ?? [
        { id: "main-token", tenantId: "main", secretEnv: "NEXUS_TEST_TOKEN" },
      ],
    },
    tenants: options.tenants ?? [{ id: "main", allowedModels: models.map(({ alias }) => alias) }],
    providers,
    models,
  };
};

export const runtimeSecrets = (
  inbound: Readonly<Record<string, string>> = { "main-token": "test-bearer-token" },
): RuntimeSecrets => ({
  inboundTokens: new Map(
    Object.entries(inbound).map(([id, value]) => [id, new SecretValue(value)]),
  ),
  providerApiKeys: new Map(),
});

export const loadedConfig = (
  config: NexusConfig,
  inbound?: Readonly<Record<string, string>>,
): LoadedConfig => ({ config, secrets: runtimeSecrets(inbound) });

export const chatRequest = (model = "public-chat", stream = false): ChatRequest => ({
  model,
  messages: [
    { role: "system", content: "System rules" },
    { role: "developer", content: "Developer rules" },
    { role: "user", content: "Hello" },
  ],
  stream,
});

export const completion = (model: string, content = "done"): ProviderCompletion => ({
  id: `completion-${model}`,
  created: 1_700_000_000,
  model,
  content,
  finishReason: "stop",
  usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
});

type CompleteImplementation = (
  request: ResolvedChatRequest,
  context: AttemptContext,
) => Promise<ProviderCompletion>;

type StreamImplementation = (
  request: ResolvedChatRequest,
  context: AttemptContext,
) => AsyncIterable<ProviderStreamEvent>;

export class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly #completeImplementation: CompleteImplementation;
  readonly #streamImplementation: StreamImplementation;
  readonly #closeImplementation: () => Promise<void>;

  constructor(
    id: string,
    options: {
      readonly complete?: CompleteImplementation;
      readonly stream?: StreamImplementation;
      readonly close?: () => Promise<void>;
    } = {},
  ) {
    this.id = id;
    this.#completeImplementation =
      options.complete ?? (async (request) => Promise.resolve(completion(request.model)));
    this.#streamImplementation =
      options.stream ??
      async function* (request): AsyncIterable<ProviderStreamEvent> {
        yield {
          type: "start",
          id: `stream-${request.model}`,
          created: 1_700_000_000,
          model: request.model,
        };
        yield { type: "text-delta", text: "done" };
        yield { type: "end", finishReason: "stop" };
      };
    this.#closeImplementation = options.close ?? (() => Promise.resolve());
  }

  complete(request: ResolvedChatRequest, context: AttemptContext): Promise<ProviderCompletion> {
    return this.#completeImplementation(request, context);
  }

  stream(
    request: ResolvedChatRequest,
    context: AttemptContext,
  ): AsyncIterable<ProviderStreamEvent> {
    return this.#streamImplementation(request, context);
  }

  close(): Promise<void> {
    return this.#closeImplementation();
  }
}

export const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    const fail = (): void => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      fail();
    } else {
      signal.addEventListener("abort", fail, { once: true });
    }
  });

export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const eventually = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before the test deadline");
    await sleep(5);
  }
};
