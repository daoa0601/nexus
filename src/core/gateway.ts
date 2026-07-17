import type { RuntimeSecrets } from "../config/secret.js";
import { NexusError } from "../errors.js";
import type { ProviderAdapter } from "../providers/contract.js";
import { ProviderRegistry } from "../providers/registry.js";
import { AttemptLedger } from "../telemetry/ledger.js";
import type {
  ChatRequest,
  ModelAliasConfig,
  NexusConfig,
  RequestExecutionContext,
  RoutedCompletion,
  RoutedStreamEvent,
} from "../types.js";
import { AttemptExecutor } from "./attempt-executor.js";

export class NexusGateway {
  readonly #models: ReadonlyMap<string, ModelAliasConfig>;
  readonly #registry: ProviderRegistry;
  readonly #executor: AttemptExecutor;
  readonly ledger: AttemptLedger;

  constructor(config: NexusConfig, registry: ProviderRegistry, ledger = new AttemptLedger()) {
    this.#models = new Map(config.models.map((model) => [model.alias, model]));
    this.#registry = registry;
    this.ledger = ledger;
    this.#executor = new AttemptExecutor(registry, ledger);
  }

  model(alias: string): ModelAliasConfig {
    const model = this.#models.get(alias);
    if (model === undefined) {
      throw new NexusError("MODEL_NOT_FOUND", `The model '${alias}' does not exist`);
    }
    return model;
  }

  models(): ReadonlyArray<ModelAliasConfig> {
    return [...this.#models.values()];
  }

  complete(request: ChatRequest, context: RequestExecutionContext): Promise<RoutedCompletion> {
    const model = this.model(request.model);
    return this.#executor.complete(
      { ...request, publicModel: model.alias, model: model.targets[0]?.model ?? model.alias },
      model.targets,
      model.routing,
      context,
    );
  }

  stream(
    request: ChatRequest,
    context: RequestExecutionContext,
  ): AsyncGenerator<RoutedStreamEvent> {
    const model = this.model(request.model);
    return this.#executor.stream(
      { ...request, publicModel: model.alias, model: model.targets[0]?.model ?? model.alias },
      model.targets,
      context,
    );
  }

  close(): Promise<void> {
    return this.#registry.close();
  }
}

export interface NexusGatewayOptions {
  readonly config: NexusConfig;
  readonly secrets: RuntimeSecrets;
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>;
  readonly ledger?: AttemptLedger;
}

export const createNexusGateway = (options: NexusGatewayOptions): NexusGateway => {
  const ledger = options.ledger ?? new AttemptLedger();
  const registry = new ProviderRegistry(options.config, options.secrets, options.adapters);
  return new NexusGateway(options.config, registry, ledger);
};
