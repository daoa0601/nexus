import { randomUUID } from "node:crypto";

import {
  AttemptTimeoutReason,
  ClientDisconnectReason,
  DeadlineAbortReason,
  HedgeLoserReason,
  NexusError,
  ShutdownAbortReason,
} from "../errors.js";
import {
  normalizeProviderFailure,
  ProviderFailure,
  type ProviderCompletion,
  type ProviderStreamEvent,
} from "../providers/contract.js";
import { ProviderRegistry } from "../providers/registry.js";
import { AttemptLedger } from "../telemetry/ledger.js";
import type {
  ModelTargetConfig,
  ResolvedChatRequest,
  RoutedCompletion,
  RoutedStreamEvent,
  RoutingConfig,
  RequestExecutionContext,
  TokenUsage,
} from "../types.js";

interface AttemptScope {
  readonly controller: AbortController;
  readonly deadline: number;
  readonly dispose: () => void;
}

interface AttemptSuccess {
  readonly kind: "success";
  readonly attemptId: string;
  readonly completion: ProviderCompletion;
  readonly target: ModelTargetConfig;
}

interface AttemptFailure {
  readonly kind: "failure";
  readonly failure: ProviderFailure;
}

type AttemptResult = AttemptSuccess | AttemptFailure;

interface LaunchedAttempt {
  readonly controller: AbortController;
  readonly result: Promise<AttemptResult>;
}

const createAttemptScope = (context: RequestExecutionContext, timeoutMs: number): AttemptScope => {
  const controller = new AbortController();
  const deadline = Math.min(context.deadline, Date.now() + timeoutMs);
  const onRootAbort = (): void => controller.abort(context.signal.reason);
  if (context.signal.aborted) {
    onRootAbort();
  } else {
    context.signal.addEventListener("abort", onRootAbort, { once: true });
  }
  const remaining = deadline - Date.now();
  const timer = setTimeout(
    () =>
      controller.abort(
        deadline === context.deadline ? new DeadlineAbortReason() : new AttemptTimeoutReason(),
      ),
    Math.max(0, remaining),
  );
  timer.unref();
  return {
    controller,
    deadline,
    dispose: () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onRootAbort);
    },
  };
};

const waitForDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (milliseconds === 0) return Promise.resolve();
  if (signal.aborted)
    return Promise.reject(new ProviderFailure("canceled", "Provider request canceled", true));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new ProviderFailure("canceled", "Provider request canceled", true));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
};

const terminalForFailure = (
  failure: ProviderFailure,
  scope: AttemptScope,
  rootSignal: AbortSignal,
): { readonly outcome: "failure" | "canceled" | "loser"; readonly failureKind: string } => {
  if (scope.controller.signal.reason instanceof HedgeLoserReason) {
    return { outcome: "loser", failureKind: "hedge-loser" };
  }
  if (rootSignal.aborted || scope.controller.signal.reason instanceof DeadlineAbortReason) {
    return {
      outcome: "canceled",
      failureKind:
        scope.controller.signal.reason instanceof DeadlineAbortReason ? "deadline" : "canceled",
    };
  }
  if (scope.controller.signal.reason instanceof AttemptTimeoutReason) {
    return { outcome: "failure", failureKind: "attempt-timeout" };
  }
  if (failure.kind === "canceled") {
    return { outcome: "canceled", failureKind: "canceled" };
  }
  return { outcome: "failure", failureKind: failure.kind };
};

const executionError = (
  failures: ReadonlyArray<ProviderFailure>,
  context: RequestExecutionContext,
): NexusError => {
  const reason = context.signal.reason;
  if (reason instanceof ShutdownAbortReason) {
    return new NexusError("SERVER_SHUTTING_DOWN", "Nexus is shutting down");
  }
  if (reason instanceof DeadlineAbortReason || Date.now() >= context.deadline) {
    return new NexusError("DEADLINE_EXCEEDED", "The request deadline was exceeded");
  }
  if (failures.length > 0 && failures.every(({ kind }) => kind === "rate-limit")) {
    return new NexusError("RATE_LIMITED", "All eligible upstream targets are rate limited");
  }
  return new NexusError(
    "UPSTREAM_UNAVAILABLE",
    "No eligible upstream target completed the request",
  );
};

export class AttemptExecutor {
  readonly #registry: ProviderRegistry;
  readonly #ledger: AttemptLedger;

  constructor(registry: ProviderRegistry, ledger: AttemptLedger) {
    this.#registry = registry;
    this.#ledger = ledger;
  }

  #launchComplete(
    request: ResolvedChatRequest,
    target: ModelTargetConfig,
    context: RequestExecutionContext,
    delayMs: number,
  ): LaunchedAttempt {
    const provider = this.#registry.tryAcquire(target.providerId);
    if (provider === undefined) {
      const controller = new AbortController();
      return {
        controller,
        result: Promise.resolve({
          kind: "failure",
          failure: new ProviderFailure("unavailable", "Provider concurrency limit reached", true),
        }),
      };
    }
    const scope = createAttemptScope(context, provider.config.requestTimeoutMs);
    const result = (async (): Promise<AttemptResult> => {
      let attemptId: string | undefined;
      try {
        await waitForDelay(delayMs, scope.controller.signal);
        if (scope.controller.signal.aborted) {
          throw new ProviderFailure("canceled", "Provider request canceled", true);
        }
        attemptId = this.#ledger.start({
          requestId: context.requestId,
          tenantId: context.tenantId,
          publicModel: request.publicModel,
          providerId: target.providerId,
          targetModel: target.model,
        });
        const completion = await provider.adapter.complete(
          { ...request, model: target.model },
          {
            requestId: context.requestId,
            tenantId: context.tenantId,
            deadline: scope.deadline,
            signal: scope.controller.signal,
          },
        );
        if (scope.controller.signal.aborted) {
          throw new ProviderFailure("canceled", "Provider request canceled", true);
        }
        return { kind: "success", attemptId, completion, target };
      } catch (error) {
        const failure = normalizeProviderFailure(error);
        if (attemptId !== undefined && this.#ledger.isPending(attemptId)) {
          this.#ledger.finish(attemptId, terminalForFailure(failure, scope, context.signal));
        }
        return { kind: "failure", failure };
      } finally {
        scope.dispose();
        provider.release();
      }
    })();
    return { controller: scope.controller, result };
  }

  async #fallback(
    request: ResolvedChatRequest,
    targets: ReadonlyArray<ModelTargetConfig>,
    context: RequestExecutionContext,
    priorFailures: ReadonlyArray<ProviderFailure> = [],
  ): Promise<RoutedCompletion> {
    const failures = [...priorFailures];
    for (const target of targets) {
      const attempt = this.#launchComplete(request, target, context, 0);
      const result = await attempt.result;
      if (result.kind === "success") {
        if (context.signal.aborted || Date.now() >= context.deadline) {
          this.#ledger.finish(result.attemptId, { outcome: "canceled", failureKind: "deadline" });
          throw executionError(failures, context);
        }
        this.#ledger.finish(result.attemptId, {
          outcome: "success",
          ...(result.completion.usage === undefined ? {} : { usage: result.completion.usage }),
        });
        return {
          providerId: result.target.providerId,
          targetModel: result.target.model,
          completion: result.completion,
        };
      }
      failures.push(result.failure);
      if (context.signal.aborted || Date.now() >= context.deadline) {
        throw executionError(failures, context);
      }
      if (!result.failure.retryable) {
        throw executionError(failures, context);
      }
    }
    throw executionError(failures, context);
  }

  async #hedge(
    request: ResolvedChatRequest,
    targets: ReadonlyArray<ModelTargetConfig>,
    routing: Extract<RoutingConfig, { readonly mode: "hedge" }>,
    context: RequestExecutionContext,
  ): Promise<RoutedCompletion> {
    const hedgedTargets = targets.slice(0, routing.maxParallel);
    const fallbackTargets = targets.slice(routing.maxParallel);
    const attempts = hedgedTargets.map((target, index) =>
      this.#launchComplete(request, target, context, index * routing.hedgeDelayMs),
    );
    const pending = new Map(
      attempts.map(
        (attempt, index) => [index, attempt.result.then((result) => ({ index, result }))] as const,
      ),
    );
    const failures: ProviderFailure[] = [];

    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);
      if (settled.result.kind === "failure") {
        failures.push(settled.result.failure);
        if (context.signal.aborted || Date.now() >= context.deadline) {
          for (const attempt of attempts)
            attempt.controller.abort(context.signal.reason ?? new DeadlineAbortReason());
          const allResults = await Promise.all(attempts.map(({ result }) => result));
          const failureKind =
            context.signal.reason instanceof DeadlineAbortReason || Date.now() >= context.deadline
              ? "deadline"
              : "canceled";
          allResults.forEach((result) => {
            if (result.kind === "success" && this.#ledger.isPending(result.attemptId)) {
              this.#ledger.finish(result.attemptId, {
                outcome: "canceled",
                failureKind,
                ...(result.completion.usage === undefined
                  ? {}
                  : { usage: result.completion.usage }),
              });
            }
          });
          throw executionError(failures, context);
        }
        continue;
      }

      const winner = settled.result;
      this.#ledger.finish(winner.attemptId, {
        outcome: "success",
        ...(winner.completion.usage === undefined ? {} : { usage: winner.completion.usage }),
      });
      attempts.forEach((attempt, index) => {
        if (index !== settled.index) attempt.controller.abort(new HedgeLoserReason());
      });
      const allResults = await Promise.all(attempts.map(({ result }) => result));
      allResults.forEach((result, index) => {
        if (
          index !== settled.index &&
          result.kind === "success" &&
          this.#ledger.isPending(result.attemptId)
        ) {
          this.#ledger.finish(result.attemptId, {
            outcome: "loser",
            failureKind: "hedge-loser",
            ...(result.completion.usage === undefined ? {} : { usage: result.completion.usage }),
          });
        }
      });
      return {
        providerId: winner.target.providerId,
        targetModel: winner.target.model,
        completion: winner.completion,
      };
    }

    if (fallbackTargets.length > 0 && failures.every(({ retryable }) => retryable)) {
      return this.#fallback(request, fallbackTargets, context, failures);
    }
    throw executionError(failures, context);
  }

  complete(
    request: ResolvedChatRequest,
    targets: ReadonlyArray<ModelTargetConfig>,
    routing: RoutingConfig,
    context: RequestExecutionContext,
  ): Promise<RoutedCompletion> {
    if (routing.mode === "hedge" && targets.length > 1) {
      return this.#hedge(request, targets, routing, context);
    }
    return this.#fallback(request, targets, context);
  }

  async *stream(
    request: ResolvedChatRequest,
    targets: ReadonlyArray<ModelTargetConfig>,
    context: RequestExecutionContext,
  ): AsyncGenerator<RoutedStreamEvent> {
    const failures: ProviderFailure[] = [];
    for (const target of targets) {
      const provider = this.#registry.tryAcquire(target.providerId);
      if (provider === undefined) {
        failures.push(
          new ProviderFailure("unavailable", "Provider concurrency limit reached", true),
        );
        continue;
      }
      const scope = createAttemptScope(context, provider.config.requestTimeoutMs);
      const attemptId = this.#ledger.start({
        requestId: context.requestId,
        tenantId: context.tenantId,
        publicModel: request.publicModel,
        providerId: target.providerId,
        targetModel: target.model,
      });
      let iterator: AsyncIterator<ProviderStreamEvent> | undefined;
      let pinned = false;
      let settled = false;
      let latestUsage: TokenUsage | undefined;
      let usageEmitted = false;
      let startEvent: Extract<RoutedStreamEvent, { readonly type: "start" }> = {
        type: "start",
        providerId: target.providerId,
        targetModel: target.model,
        id: `chatcmpl-nexus-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: target.model,
      };
      try {
        iterator = provider.adapter
          .stream(
            { ...request, model: target.model },
            {
              requestId: context.requestId,
              tenantId: context.tenantId,
              deadline: scope.deadline,
              signal: scope.controller.signal,
            },
          )
          [Symbol.asyncIterator]();

        while (true) {
          const next = await iterator.next();
          if (scope.controller.signal.aborted) {
            throw new ProviderFailure("canceled", "Provider stream canceled", true);
          }
          if (next.done) {
            this.#ledger.finish(attemptId, {
              outcome: "success",
              ...(latestUsage === undefined ? {} : { usage: latestUsage }),
            });
            settled = true;
            if (!pinned) {
              pinned = true;
              yield startEvent;
            }
            if (latestUsage !== undefined && !usageEmitted)
              yield { type: "usage", usage: latestUsage };
            yield { type: "end", finishReason: null };
            return;
          }
          const event = next.value;
          if (event.type === "start") {
            startEvent = {
              type: "start",
              providerId: target.providerId,
              targetModel: target.model,
              id: event.id,
              created: event.created,
              model: event.model,
            };
          } else if (event.type === "usage") {
            latestUsage = event.usage;
            if (pinned) {
              usageEmitted = true;
              yield event;
            }
          } else if (event.type === "text-delta") {
            if (!pinned) {
              pinned = true;
              yield startEvent;
            }
            yield event;
          } else {
            this.#ledger.finish(attemptId, {
              outcome: "success",
              ...(latestUsage === undefined ? {} : { usage: latestUsage }),
            });
            settled = true;
            if (!pinned) {
              pinned = true;
              yield startEvent;
            }
            if (latestUsage !== undefined && !usageEmitted)
              yield { type: "usage", usage: latestUsage };
            yield event;
            return;
          }
        }
      } catch (error) {
        const failure = normalizeProviderFailure(error);
        failures.push(failure);
        if (this.#ledger.isPending(attemptId)) {
          this.#ledger.finish(attemptId, terminalForFailure(failure, scope, context.signal));
        }
        settled = true;
        if (
          pinned ||
          !failure.retryable ||
          context.signal.aborted ||
          Date.now() >= context.deadline
        ) {
          throw executionError(failures, context);
        }
      } finally {
        if (!settled && this.#ledger.isPending(attemptId)) {
          scope.controller.abort(new ClientDisconnectReason());
          this.#ledger.finish(attemptId, { outcome: "canceled", failureKind: "consumer-canceled" });
        }
        try {
          await iterator?.return?.();
        } catch {
          // The ledger already has, or immediately receives, its terminal state.
        }
        scope.dispose();
        provider.release();
      }
    }
    throw executionError(failures, context);
  }
}
