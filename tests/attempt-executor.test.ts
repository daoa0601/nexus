import { describe, expect, it } from "vitest";

import { NexusGateway } from "../src/core/gateway.js";
import { ProviderFailure } from "../src/providers/contract.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { AttemptLedger } from "../src/telemetry/ledger.js";
import type { ModelAliasConfig, RequestExecutionContext } from "../src/types.js";
import {
  chatRequest,
  completion,
  FakeAdapter,
  nexusConfig,
  providerConfig,
  runtimeSecrets,
  sleep,
  waitForAbort,
} from "./support.js";

const context = (
  requestId: string,
  timeoutMs = 500,
  signal = new AbortController().signal,
): RequestExecutionContext => ({
  requestId,
  tenantId: "main",
  deadline: Date.now() + timeoutMs,
  signal,
});

const createGateway = (
  model: ModelAliasConfig,
  adapters: ReadonlyArray<FakeAdapter>,
  requestTimeoutMs = 200,
): { readonly gateway: NexusGateway; readonly ledger: AttemptLedger } => {
  const providers = adapters.map(({ id }) => providerConfig(id, { requestTimeoutMs }));
  const config = nexusConfig({ providers, models: [model], server: { requestTimeoutMs } });
  const registry = new ProviderRegistry(
    config,
    runtimeSecrets(),
    new Map(adapters.map((adapter) => [adapter.id, adapter])),
  );
  const ledger = new AttemptLedger();
  return { gateway: new NexusGateway(config, registry, ledger), ledger };
};

describe("attempt execution", () => {
  it("falls back deterministically after a retryable failure", async () => {
    const calls: string[] = [];
    const first = new FakeAdapter("first", {
      complete: async (request) => {
        calls.push(request.model);
        throw new ProviderFailure("unavailable", "temporary failure", true);
      },
    });
    const second = new FakeAdapter("second", {
      complete: async (request) => {
        calls.push(request.model);
        return completion(request.model, "fallback worked");
      },
    });
    const { gateway, ledger } = createGateway(
      {
        alias: "public-chat",
        equivalentTargets: true,
        targets: [
          { providerId: "first", model: "first-model" },
          { providerId: "second", model: "second-model" },
        ],
        routing: { mode: "fallback" },
      },
      [first, second],
    );

    try {
      const result = await gateway.complete(chatRequest(), context("fallback"));
      expect(result.providerId).toBe("second");
      expect(result.targetModel).toBe("second-model");
      expect(result.completion.content).toBe("fallback worked");
      expect(calls).toEqual(["first-model", "second-model"]);
      expect(ledger.snapshot("fallback").map(({ outcome }) => outcome)).toEqual([
        "failure",
        "success",
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("waits for a later hedge success after the first promise rejects", async () => {
    const first = new FakeAdapter("first", {
      complete: async () => {
        await sleep(5);
        throw new ProviderFailure("rejected", "fast non-retryable rejection", false);
      },
    });
    const second = new FakeAdapter("second", {
      complete: async (request) => {
        await sleep(25);
        return completion(request.model, "later success");
      },
    });
    const { gateway, ledger } = createGateway(
      {
        alias: "public-chat",
        equivalentTargets: true,
        targets: [
          { providerId: "first", model: "equivalent-a" },
          { providerId: "second", model: "equivalent-b" },
        ],
        routing: { mode: "hedge", hedgeDelayMs: 0, maxParallel: 2 },
      },
      [first, second],
    );

    try {
      const result = await gateway.complete(chatRequest(), context("hedge-rejection"));
      expect(result.providerId).toBe("second");
      expect(result.completion.content).toBe("later success");
      expect(
        ledger
          .snapshot("hedge-rejection")
          .map(({ outcome }) => outcome)
          .sort(),
      ).toEqual(["failure", "success"]);
    } finally {
      await gateway.close();
    }
  });

  it("aborts and records a still-running hedge loser", async () => {
    let loserAborted = false;
    const winner = new FakeAdapter("winner", {
      complete: async (request) => {
        await sleep(15);
        return completion(request.model, "winner");
      },
    });
    const loser = new FakeAdapter("loser", {
      complete: async (_request, attemptContext) => {
        attemptContext.signal.addEventListener(
          "abort",
          () => {
            loserAborted = true;
          },
          { once: true },
        );
        return waitForAbort(attemptContext.signal);
      },
    });
    const { gateway, ledger } = createGateway(
      {
        alias: "public-chat",
        equivalentTargets: true,
        targets: [
          { providerId: "winner", model: "winner-model" },
          { providerId: "loser", model: "loser-model" },
        ],
        routing: { mode: "hedge", hedgeDelayMs: 0, maxParallel: 2 },
      },
      [winner, loser],
    );

    try {
      await gateway.complete(chatRequest(), context("hedge-loser"));
      expect(loserAborted).toBe(true);
      expect(
        ledger
          .snapshot("hedge-loser")
          .map(({ outcome }) => outcome)
          .sort(),
      ).toEqual(["loser", "success"]);
    } finally {
      await gateway.close();
    }
  });

  it("enforces one end-to-end deadline across fallback attempts", async () => {
    const first = new FakeAdapter("first", {
      complete: async () => {
        await sleep(35);
        throw new ProviderFailure("unavailable", "try fallback", true);
      },
    });
    const second = new FakeAdapter("second", {
      complete: async (_request, attemptContext) => waitForAbort(attemptContext.signal),
    });
    const { gateway, ledger } = createGateway(
      {
        alias: "public-chat",
        equivalentTargets: true,
        targets: [
          { providerId: "first", model: "first-model" },
          { providerId: "second", model: "second-model" },
        ],
        routing: { mode: "fallback" },
      },
      [first, second],
      250,
    );
    const startedAt = Date.now();

    try {
      await expect(
        gateway.complete(chatRequest(), context("root-deadline", 70)),
      ).rejects.toMatchObject({
        code: "DEADLINE_EXCEEDED",
      });
      expect(Date.now() - startedAt).toBeLessThan(180);
      expect(ledger.snapshot("root-deadline").map(({ outcome }) => outcome)).toEqual([
        "failure",
        "canceled",
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("falls back before content, pins after content, and closes the winning stream iterator", async () => {
    let winningIteratorClosed = false;
    const first = new FakeAdapter("first", {
      stream: async function* () {
        yield { type: "start", id: "ignored-start", created: 1, model: "first-model" };
        throw new ProviderFailure("unavailable", "failed before content", true);
      },
    });
    const second = new FakeAdapter("second", {
      stream: async function* () {
        try {
          yield { type: "start", id: "winning-start", created: 2, model: "second-model" };
          yield { type: "text-delta", text: "hello" };
          yield { type: "end", finishReason: "stop" };
        } finally {
          winningIteratorClosed = true;
        }
      },
    });
    const { gateway, ledger } = createGateway(
      {
        alias: "public-chat",
        equivalentTargets: true,
        targets: [
          { providerId: "first", model: "first-model" },
          { providerId: "second", model: "second-model" },
        ],
        routing: { mode: "fallback" },
      },
      [first, second],
    );

    try {
      const events = [];
      for await (const event of gateway.stream(
        chatRequest("public-chat", true),
        context("stream-fallback"),
      )) {
        events.push(event);
      }
      expect(events.map(({ type }) => type)).toEqual(["start", "text-delta", "end"]);
      expect(events[0]).toMatchObject({ providerId: "second", targetModel: "second-model" });
      expect(winningIteratorClosed).toBe(true);
      expect(ledger.snapshot("stream-fallback").map(({ outcome }) => outcome)).toEqual([
        "failure",
        "success",
      ]);
    } finally {
      await gateway.close();
    }
  });
});
