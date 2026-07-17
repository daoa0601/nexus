import { inspect } from "node:util";

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { loadConfigText } from "../src/config/load.js";
import { decodeConfig, parseConfigText } from "../src/config/schema.js";
import { SecretValue } from "../src/config/secret.js";
import { decodeChatRequest } from "../src/core/request.js";
import { nexusConfig, providerConfig } from "./support.js";

describe("Nexus configuration", () => {
  it("strictly loads equivalent JSON and YAML documents", () => {
    const config = nexusConfig();
    const environment = { NEXUS_TEST_TOKEN: "inbound-secret" };

    const fromJson = loadConfigText(JSON.stringify(config), environment);
    const fromYaml = loadConfigText(stringify(config), environment);

    expect(fromJson.config).toEqual(config);
    expect(fromYaml.config).toEqual(config);
    expect(fromJson.secrets.inboundTokens.get("main-token")?.reveal()).toBe("inbound-secret");
  });

  it("rejects unknown keys, duplicate IDs and aliases, and invalid limits", () => {
    const config = nexusConfig();
    expect(() => decodeConfig({ ...config, unexpected: true })).toThrow(/unknown key: unexpected/);

    const firstProvider = config.providers[0];
    expect(firstProvider).toBeDefined();
    expect(() =>
      decodeConfig({ ...config, providers: [...config.providers, firstProvider] }),
    ).toThrow(/duplicate value: primary/);

    const firstModel = config.models[0];
    expect(firstModel).toBeDefined();
    expect(() => decodeConfig({ ...config, models: [...config.models, firstModel] })).toThrow(
      /duplicate value: public-chat/,
    );

    expect(() =>
      decodeConfig({ ...config, server: { ...config.server, requestTimeoutMs: 0 } }),
    ).toThrow(/requestTimeoutMs must be an integer/);
  });

  it("rejects duplicate YAML keys and insecure non-loopback HTTP providers", () => {
    expect(() => parseConfigText("version: 1\nversion: 1\n")).toThrow(/document syntax error/);
    expect(() => parseConfigText("version: &version 1\ncopy: *version\n")).toThrow(
      /document conversion error: Alias resolution is disabled/,
    );

    const config = nexusConfig({
      providers: [
        providerConfig("primary", {
          baseUrl: "http://provider.example/v1",
          allowLoopbackHttp: true,
        }),
      ],
    });
    expect(() => decodeConfig(config)).toThrow(/rejects insecure non-loopback HTTP/);
  });

  it("requires every referenced secret and unique inbound token values", () => {
    const text = JSON.stringify(nexusConfig());
    expect(() => loadConfigText(text, {})).toThrow(
      /Missing required environment secret: NEXUS_TEST_TOKEN/,
    );

    const config = nexusConfig({
      tenants: [{ id: "main", allowedModels: ["public-chat"] }],
      tokens: [
        { id: "first", tenantId: "main", secretEnv: "FIRST_TOKEN" },
        { id: "second", tenantId: "main", secretEnv: "SECOND_TOKEN" },
      ],
    });
    expect(() =>
      loadConfigText(JSON.stringify(config), { FIRST_TOKEN: "same", SECOND_TOKEN: "same" }),
    ).toThrow(/bearer token values must be unique/);
  });

  it("redacts secrets under serialization, coercion, and inspection", () => {
    const secret = new SecretValue("never-print-this-value");

    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(String(secret)).toBe("[REDACTED]");
    expect(inspect(secret)).toBe("SecretValue([REDACTED])");
    expect(`${secret}`).not.toContain("never-print-this-value");
  });

  it("applies the configured output ceiling when the client omits a token limit", () => {
    const config = nexusConfig({ server: { maxOutputTokens: 73 } });
    const request = decodeChatRequest(
      { model: "public-chat", messages: [{ role: "user", content: "hello" }] },
      config.server,
    );

    expect(request.maxTokens).toBeUndefined();
    expect(request.maxCompletionTokens).toBe(73);
  });
});
