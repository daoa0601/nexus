import { randomUUID } from "node:crypto";

import type { TokenUsage } from "../types.js";

export type AttemptOutcome = "pending" | "success" | "failure" | "canceled" | "loser";

export interface AttemptRecord {
  readonly attemptId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly publicModel: string;
  readonly providerId: string;
  readonly targetModel: string;
  readonly startedAt: string;
  readonly outcome: AttemptOutcome;
  readonly latencyMs?: number;
  readonly failureKind?: string;
  readonly usage?: TokenUsage;
}

interface MutableAttempt {
  readonly attemptId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly publicModel: string;
  readonly providerId: string;
  readonly targetModel: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  outcome: AttemptOutcome;
  latencyMs?: number;
  failureKind?: string;
  usage?: TokenUsage;
}

export interface AttemptStart {
  readonly requestId: string;
  readonly tenantId: string;
  readonly publicModel: string;
  readonly providerId: string;
  readonly targetModel: string;
}

export interface AttemptTerminal {
  readonly outcome: Exclude<AttemptOutcome, "pending">;
  readonly failureKind?: string;
  readonly usage?: TokenUsage;
}

export class AttemptLedger {
  readonly #records = new Map<string, MutableAttempt>();

  start(input: AttemptStart): string {
    const attemptId = randomUUID();
    const startedAtMs = Date.now();
    this.#records.set(attemptId, {
      ...input,
      attemptId,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      outcome: "pending",
    });
    return attemptId;
  }

  finish(attemptId: string, terminal: AttemptTerminal): void {
    const record = this.#records.get(attemptId);
    if (record === undefined) {
      throw new Error("Unknown attempt ledger record");
    }
    if (record.outcome !== "pending") {
      throw new Error("Attempt ledger record already has a terminal state");
    }
    record.outcome = terminal.outcome;
    record.latencyMs = Math.max(0, Date.now() - record.startedAtMs);
    if (terminal.failureKind !== undefined) record.failureKind = terminal.failureKind;
    if (terminal.usage !== undefined) record.usage = terminal.usage;
  }

  isPending(attemptId: string): boolean {
    return this.#records.get(attemptId)?.outcome === "pending";
  }

  snapshot(requestId?: string): ReadonlyArray<AttemptRecord> {
    return [...this.#records.values()]
      .filter((record) => requestId === undefined || record.requestId === requestId)
      .map(({ startedAtMs: _startedAtMs, ...record }) => Object.freeze({ ...record }));
  }
}
