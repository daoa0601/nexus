import { parseDocument } from "yaml";

import { NexusError } from "../errors.js";
import { validateProviderEndpoint } from "../security/endpoint-policy.js";
import type {
  FallbackRoutingConfig,
  HedgeRoutingConfig,
  ModelAliasConfig,
  ModelTargetConfig,
  NexusConfig,
  ProviderConfig,
  ServerConfig,
  TenantConfig,
  TokenReferenceConfig,
} from "../types.js";

type UnknownRecord = Record<string, unknown>;

const fail = (message: string): never => {
  throw new NexusError("INVALID_REQUEST", `Invalid Nexus configuration: ${message}`);
};

const asRecord = (value: unknown, path: string): UnknownRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${path} must be an object`);
  }
  return value as UnknownRecord;
};

const exactKeys = (
  record: UnknownRecord,
  path: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(
      `${path} contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.sort().join(", ")}`,
    );
  }
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    fail(`${path} is missing ${missing.length === 1 ? "key" : "keys"}: ${missing.join(", ")}`);
  }
};

const asArray = (value: unknown, path: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) {
    return fail(`${path} must be an array`);
  }
  return value;
};

const nonEmptyArray = (value: unknown, path: string): ReadonlyArray<unknown> => {
  const array = asArray(value, path);
  if (array.length === 0) {
    fail(`${path} must not be empty`);
  }
  return array;
};

const asString = (value: unknown, path: string, maximum = 256): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    return fail(`${path} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
};

const asIdentifier = (value: unknown, path: string): string => {
  const identifier = asString(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(identifier)) {
    fail(`${path} contains unsupported characters`);
  }
  return identifier;
};

const asEnvName = (value: unknown, path: string): string => {
  const name = asString(value, path, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    fail(`${path} must be an environment variable name`);
  }
  return name;
};

const asBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    return fail(`${path} must be a boolean`);
  }
  return value;
};

const asInteger = (value: unknown, path: string, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
};

const assertUnique = (values: ReadonlyArray<string>, path: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`${path} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
};

const decodeServer = (value: unknown): ServerConfig => {
  const record = asRecord(value, "server");
  exactKeys(record, "server", [
    "host",
    "port",
    "requestTimeoutMs",
    "bodyLimitBytes",
    "maxMessages",
    "maxContentChars",
    "maxOutputTokens",
    "maxConcurrentRequests",
    "shutdownGraceMs",
  ]);
  return Object.freeze({
    host: asString(record.host, "server.host", 255),
    port: asInteger(record.port, "server.port", 0, 65_535),
    requestTimeoutMs: asInteger(record.requestTimeoutMs, "server.requestTimeoutMs", 1, 600_000),
    bodyLimitBytes: asInteger(record.bodyLimitBytes, "server.bodyLimitBytes", 1, 10 * 1024 * 1024),
    maxMessages: asInteger(record.maxMessages, "server.maxMessages", 1, 10_000),
    maxContentChars: asInteger(record.maxContentChars, "server.maxContentChars", 1, 10_000_000),
    maxOutputTokens: asInteger(record.maxOutputTokens, "server.maxOutputTokens", 1, 1_000_000),
    maxConcurrentRequests: asInteger(
      record.maxConcurrentRequests,
      "server.maxConcurrentRequests",
      1,
      10_000,
    ),
    shutdownGraceMs: asInteger(record.shutdownGraceMs, "server.shutdownGraceMs", 1, 600_000),
  });
};

const decodeTokenReferences = (value: unknown): ReadonlyArray<TokenReferenceConfig> => {
  const auth = asRecord(value, "auth");
  exactKeys(auth, "auth", ["tokens"]);
  const tokens = nonEmptyArray(auth.tokens, "auth.tokens").map((entry, index) => {
    const path = `auth.tokens[${index}]`;
    const record = asRecord(entry, path);
    exactKeys(record, path, ["id", "tenantId", "secretEnv"]);
    return Object.freeze({
      id: asIdentifier(record.id, `${path}.id`),
      tenantId: asIdentifier(record.tenantId, `${path}.tenantId`),
      secretEnv: asEnvName(record.secretEnv, `${path}.secretEnv`),
    });
  });
  assertUnique(
    tokens.map(({ id }) => id),
    "auth token IDs",
  );
  assertUnique(
    tokens.map(({ secretEnv }) => secretEnv),
    "auth token secret references",
  );
  return Object.freeze(tokens);
};

const decodeTenants = (value: unknown): ReadonlyArray<TenantConfig> => {
  const tenants = nonEmptyArray(value, "tenants").map((entry, index) => {
    const path = `tenants[${index}]`;
    const record = asRecord(entry, path);
    exactKeys(record, path, ["id", "allowedModels"]);
    const allowedModels = nonEmptyArray(record.allowedModels, `${path}.allowedModels`).map(
      (model, modelIndex) => asIdentifier(model, `${path}.allowedModels[${modelIndex}]`),
    );
    assertUnique(allowedModels, `${path}.allowedModels`);
    return Object.freeze({
      id: asIdentifier(record.id, `${path}.id`),
      allowedModels: Object.freeze(allowedModels),
    });
  });
  assertUnique(
    tenants.map(({ id }) => id),
    "tenant IDs",
  );
  return Object.freeze(tenants);
};

const decodeProviders = (
  value: unknown,
  serverTimeoutMs: number,
): ReadonlyArray<ProviderConfig> => {
  const providers = nonEmptyArray(value, "providers").map((entry, index) => {
    const path = `providers[${index}]`;
    const record = asRecord(entry, path);
    exactKeys(
      record,
      path,
      ["id", "type", "baseUrl", "allowLoopbackHttp", "requestTimeoutMs", "maxConcurrency"],
      ["apiKeyEnv"],
    );
    if (record.type !== "openai-compatible") {
      fail(`${path}.type must be openai-compatible`);
    }
    const allowLoopbackHttp = asBoolean(record.allowLoopbackHttp, `${path}.allowLoopbackHttp`);
    const baseUrl = validateProviderEndpoint(
      asString(record.baseUrl, `${path}.baseUrl`, 2048),
      allowLoopbackHttp,
      `${path}.baseUrl`,
    );
    const requestTimeoutMs = asInteger(
      record.requestTimeoutMs,
      `${path}.requestTimeoutMs`,
      1,
      600_000,
    );
    if (requestTimeoutMs > serverTimeoutMs) {
      fail(`${path}.requestTimeoutMs must not exceed server.requestTimeoutMs`);
    }
    const apiKeyEnv =
      record.apiKeyEnv === undefined ? undefined : asEnvName(record.apiKeyEnv, `${path}.apiKeyEnv`);
    if (baseUrl.startsWith("https://") && apiKeyEnv === undefined) {
      fail(`${path}.apiKeyEnv is required for HTTPS providers`);
    }
    const common = {
      id: asIdentifier(record.id, `${path}.id`),
      type: "openai-compatible" as const,
      baseUrl,
      allowLoopbackHttp,
      requestTimeoutMs,
      maxConcurrency: asInteger(record.maxConcurrency, `${path}.maxConcurrency`, 1, 10_000),
    };
    return Object.freeze(apiKeyEnv === undefined ? common : { ...common, apiKeyEnv });
  });
  assertUnique(
    providers.map(({ id }) => id),
    "provider IDs",
  );
  return Object.freeze(providers);
};

const decodeTarget = (value: unknown, path: string): ModelTargetConfig => {
  const record = asRecord(value, path);
  exactKeys(record, path, ["providerId", "model"]);
  return Object.freeze({
    providerId: asIdentifier(record.providerId, `${path}.providerId`),
    model: asString(record.model, `${path}.model`, 256),
  });
};

const decodeRouting = (value: unknown, path: string, targetCount: number, equivalent: boolean) => {
  const record = asRecord(value, path);
  if (record.mode === "fallback") {
    exactKeys(record, path, ["mode"]);
    return Object.freeze({ mode: "fallback" }) satisfies FallbackRoutingConfig;
  }
  if (record.mode === "hedge") {
    exactKeys(record, path, ["mode", "hedgeDelayMs", "maxParallel"]);
    if (!equivalent || targetCount < 2) {
      fail(`${path}.mode hedge requires at least two explicitly equivalent targets`);
    }
    const maxParallel = asInteger(record.maxParallel, `${path}.maxParallel`, 2, targetCount);
    return Object.freeze({
      mode: "hedge",
      hedgeDelayMs: asInteger(record.hedgeDelayMs, `${path}.hedgeDelayMs`, 0, 60_000),
      maxParallel,
    }) satisfies HedgeRoutingConfig;
  }
  return fail(`${path}.mode must be fallback or hedge`);
};

const decodeModels = (
  value: unknown,
  providerIds: ReadonlySet<string>,
): ReadonlyArray<ModelAliasConfig> => {
  const models = nonEmptyArray(value, "models").map((entry, index) => {
    const path = `models[${index}]`;
    const record = asRecord(entry, path);
    exactKeys(record, path, ["alias", "targets", "equivalentTargets", "routing"]);
    const targets = nonEmptyArray(record.targets, `${path}.targets`).map((target, targetIndex) =>
      decodeTarget(target, `${path}.targets[${targetIndex}]`),
    );
    assertUnique(
      targets.map(({ providerId, model }) => `${providerId}/${model}`),
      `${path}.targets`,
    );
    for (const target of targets) {
      if (!providerIds.has(target.providerId)) {
        fail(`${path} references unknown provider: ${target.providerId}`);
      }
    }
    const equivalentTargets = asBoolean(record.equivalentTargets, `${path}.equivalentTargets`);
    if (targets.length > 1 && !equivalentTargets) {
      fail(
        `${path} must declare equivalentTargets: true before fallback or hedging across targets`,
      );
    }
    return Object.freeze({
      alias: asIdentifier(record.alias, `${path}.alias`),
      targets: Object.freeze(targets),
      equivalentTargets,
      routing: decodeRouting(record.routing, `${path}.routing`, targets.length, equivalentTargets),
    });
  });
  assertUnique(
    models.map(({ alias }) => alias),
    "model aliases",
  );
  return Object.freeze(models);
};

export const decodeConfig = (value: unknown): NexusConfig => {
  const root = asRecord(value, "config");
  exactKeys(root, "config", ["version", "server", "auth", "tenants", "providers", "models"]);
  if (root.version !== 1) {
    fail("version must be 1");
  }
  const server = decodeServer(root.server);
  const tokens = decodeTokenReferences(root.auth);
  const tenants = decodeTenants(root.tenants);
  const providers = decodeProviders(root.providers, server.requestTimeoutMs);
  const models = decodeModels(root.models, new Set(providers.map(({ id }) => id)));

  const tenantIds = new Set(tenants.map(({ id }) => id));
  const aliases = new Set(models.map(({ alias }) => alias));
  for (const token of tokens) {
    if (!tenantIds.has(token.tenantId)) {
      fail(`auth token ${token.id} references unknown tenant: ${token.tenantId}`);
    }
  }
  for (const tenant of tenants) {
    for (const alias of tenant.allowedModels) {
      if (!aliases.has(alias)) {
        fail(`tenant ${tenant.id} allows unknown model alias: ${alias}`);
      }
    }
  }

  return Object.freeze({
    version: 1,
    server,
    auth: Object.freeze({ tokens }),
    tenants,
    providers,
    models,
  });
};

export const parseConfigText = (text: string): NexusConfig => {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(
      `document syntax error: ${document.errors[0]?.message.split("\n")[0] ?? "unknown parse error"}`,
    );
  }
  if (document.warnings.length > 0) {
    fail(
      `document warning: ${document.warnings[0]?.message.split("\n")[0] ?? "unsupported YAML feature"}`,
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.split("\n")[0] : "unsupported YAML feature";
    fail(`document conversion error: ${detail}`);
  }
  return decodeConfig(value);
};
