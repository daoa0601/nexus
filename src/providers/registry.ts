import type { RuntimeSecrets } from "../config/secret.js";
import { ConcurrencyGate, type Release } from "../core/concurrency.js";
import { NexusError } from "../errors.js";
import type { NexusConfig, ProviderConfig } from "../types.js";
import type { ProviderAdapter } from "./contract.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";

interface RegisteredProvider {
  readonly config: ProviderConfig;
  readonly adapter: ProviderAdapter;
  readonly gate: ConcurrencyGate;
}

export interface AcquiredProvider {
  readonly config: ProviderConfig;
  readonly adapter: ProviderAdapter;
  readonly release: Release;
}

export class ProviderRegistry {
  readonly #providers: ReadonlyMap<string, RegisteredProvider>;
  #closed = false;

  constructor(
    config: NexusConfig,
    secrets: RuntimeSecrets,
    injectedAdapters: ReadonlyMap<string, ProviderAdapter> = new Map(),
  ) {
    const providers = new Map<string, RegisteredProvider>();
    for (const providerConfig of config.providers) {
      const adapter =
        injectedAdapters.get(providerConfig.id) ??
        new OpenAICompatibleAdapter(providerConfig, secrets.providerApiKeys.get(providerConfig.id));
      if (adapter.id !== providerConfig.id) {
        throw new NexusError(
          "INVALID_REQUEST",
          `Adapter ID mismatch for provider: ${providerConfig.id}`,
        );
      }
      providers.set(providerConfig.id, {
        config: providerConfig,
        adapter,
        gate: new ConcurrencyGate(providerConfig.maxConcurrency),
      });
    }
    for (const adapterId of injectedAdapters.keys()) {
      if (!providers.has(adapterId)) {
        throw new NexusError(
          "INVALID_REQUEST",
          `Injected adapter has no provider configuration: ${adapterId}`,
        );
      }
    }
    this.#providers = providers;
  }

  tryAcquire(providerId: string): AcquiredProvider | undefined {
    if (this.#closed) return undefined;
    const provider = this.#providers.get(providerId);
    if (provider === undefined) {
      throw new NexusError("INTERNAL_ERROR", "Resolved provider is not registered");
    }
    const release = provider.gate.tryAcquire();
    return release === undefined
      ? undefined
      : { config: provider.config, adapter: provider.adapter, release };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#providers.values()].map(({ adapter }) => adapter.close()),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new NexusError("INTERNAL_ERROR", "One or more provider adapters failed to close");
    }
  }
}
