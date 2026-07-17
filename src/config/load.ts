import { readFile } from "node:fs/promises";

import * as Effect from "effect/Effect";

import { NexusError } from "../errors.js";
import type { NexusConfig } from "../types.js";
import { parseConfigText } from "./schema.js";
import { SecretValue, type RuntimeSecrets } from "./secret.js";

export interface LoadedConfig {
  readonly config: NexusConfig;
  readonly secrets: RuntimeSecrets;
}

const resolveSecret = (environment: NodeJS.ProcessEnv, name: string): SecretValue => {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new NexusError("INVALID_REQUEST", `Missing required environment secret: ${name}`);
  }
  return new SecretValue(value);
};

export const loadConfigText = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): LoadedConfig => {
  const config = parseConfigText(text);
  const inboundTokens = new Map<string, SecretValue>();
  const providerApiKeys = new Map<string, SecretValue>();

  for (const token of config.auth.tokens) {
    inboundTokens.set(token.id, resolveSecret(environment, token.secretEnv));
  }
  const observedTokenValues = new Set<string>();
  for (const secret of inboundTokens.values()) {
    const value = secret.reveal();
    if (observedTokenValues.has(value)) {
      throw new NexusError("INVALID_REQUEST", "Inbound bearer token values must be unique");
    }
    observedTokenValues.add(value);
  }
  for (const provider of config.providers) {
    if (provider.apiKeyEnv !== undefined) {
      providerApiKeys.set(provider.id, resolveSecret(environment, provider.apiKeyEnv));
    }
  }

  return Object.freeze({
    config,
    secrets: Object.freeze({ inboundTokens, providerApiKeys }),
  });
};

export const loadConfigFile = async (
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new NexusError("INVALID_REQUEST", `Unable to read Nexus configuration: ${path}`, {
      cause: error,
    });
  }
  return loadConfigText(text, environment);
};

export const loadConfigEffect = (
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<LoadedConfig, NexusError> =>
  Effect.tryPromise({
    try: () => loadConfigFile(path, environment),
    catch: (error) =>
      error instanceof NexusError
        ? error
        : new NexusError("INVALID_REQUEST", "Unable to load Nexus configuration", { cause: error }),
  });
