import type { ResolvedChatRequest, TokenUsage } from "../types.js";

export interface AttemptContext {
  readonly requestId: string;
  readonly tenantId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface ProviderCompletion {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly content: string;
  readonly finishReason: string | null;
  readonly usage?: TokenUsage;
}

export type ProviderStreamEvent =
  | {
      readonly type: "start";
      readonly id: string;
      readonly created: number;
      readonly model: string;
    }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "end"; readonly finishReason: string | null };

export interface ProviderAdapter {
  readonly id: string;
  complete(request: ResolvedChatRequest, context: AttemptContext): Promise<ProviderCompletion>;
  stream(request: ResolvedChatRequest, context: AttemptContext): AsyncIterable<ProviderStreamEvent>;
  close(): Promise<void>;
}

export type ProviderFailureKind =
  "rate-limit" | "timeout" | "unavailable" | "rejected" | "protocol" | "canceled";

export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    retryable: boolean,
    options?: { readonly status?: number; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderFailure";
    this.kind = kind;
    this.retryable = retryable;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export const normalizeProviderFailure = (error: unknown): ProviderFailure => {
  if (error instanceof ProviderFailure) {
    return error;
  }
  return new ProviderFailure("unavailable", "Provider request failed", true, { cause: error });
};
