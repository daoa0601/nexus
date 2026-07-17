export type MessageRole = "system" | "developer" | "user" | "assistant";

export interface ChatMessage {
  readonly role: MessageRole;
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly stream: boolean;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly maxCompletionTokens?: number;
  readonly stop?: string | ReadonlyArray<string>;
}

export interface ResolvedChatRequest extends Omit<ChatRequest, "model"> {
  readonly publicModel: string;
  readonly model: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ServerLimits {
  readonly requestTimeoutMs: number;
  readonly bodyLimitBytes: number;
  readonly maxMessages: number;
  readonly maxContentChars: number;
  readonly maxOutputTokens: number;
  readonly maxConcurrentRequests: number;
}

export interface ServerConfig extends ServerLimits {
  readonly host: string;
  readonly port: number;
  readonly shutdownGraceMs: number;
}

export interface TokenReferenceConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly secretEnv: string;
}

export interface TenantConfig {
  readonly id: string;
  readonly allowedModels: ReadonlyArray<string>;
}

export interface ProviderConfig {
  readonly id: string;
  readonly type: "openai-compatible";
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly allowLoopbackHttp: boolean;
  readonly requestTimeoutMs: number;
  readonly maxConcurrency: number;
}

export interface ModelTargetConfig {
  readonly providerId: string;
  readonly model: string;
}

export interface FallbackRoutingConfig {
  readonly mode: "fallback";
}

export interface HedgeRoutingConfig {
  readonly mode: "hedge";
  readonly hedgeDelayMs: number;
  readonly maxParallel: number;
}

export type RoutingConfig = FallbackRoutingConfig | HedgeRoutingConfig;

export interface ModelAliasConfig {
  readonly alias: string;
  readonly targets: ReadonlyArray<ModelTargetConfig>;
  readonly equivalentTargets: boolean;
  readonly routing: RoutingConfig;
}

export interface NexusConfig {
  readonly version: 1;
  readonly server: ServerConfig;
  readonly auth: {
    readonly tokens: ReadonlyArray<TokenReferenceConfig>;
  };
  readonly tenants: ReadonlyArray<TenantConfig>;
  readonly providers: ReadonlyArray<ProviderConfig>;
  readonly models: ReadonlyArray<ModelAliasConfig>;
}

export interface AuthenticatedTenant {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly allowedModels: ReadonlySet<string>;
}

export interface RequestExecutionContext {
  readonly requestId: string;
  readonly tenantId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface RoutedCompletion {
  readonly providerId: string;
  readonly targetModel: string;
  readonly completion: import("./providers/contract.js").ProviderCompletion;
}

export type RoutedStreamEvent =
  | {
      readonly type: "start";
      readonly providerId: string;
      readonly targetModel: string;
      readonly id: string;
      readonly created: number;
      readonly model: string;
    }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "end"; readonly finishReason: string | null };

export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: 0;
    readonly message: { readonly role: "assistant"; readonly content: string };
    readonly finish_reason: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
  readonly nexus: {
    readonly request_id: string;
    readonly public_model: string;
    readonly provider: string;
    readonly target_model: string;
  };
}
