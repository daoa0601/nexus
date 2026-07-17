import { createHash, timingSafeEqual } from "node:crypto";

import type { RuntimeSecrets } from "../config/secret.js";
import { NexusError } from "../errors.js";
import type { AuthenticatedTenant, NexusConfig } from "../types.js";

interface Credential {
  readonly digest: Buffer;
  readonly tenant: AuthenticatedTenant;
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export class TokenAuthenticator {
  readonly #credentials: ReadonlyArray<Credential>;

  constructor(config: NexusConfig, secrets: RuntimeSecrets) {
    const tenants = new Map(config.tenants.map((tenant) => [tenant.id, tenant]));
    this.#credentials = config.auth.tokens.map((reference) => {
      const secret = secrets.inboundTokens.get(reference.id);
      const tenant = tenants.get(reference.tenantId);
      if (secret === undefined || tenant === undefined) {
        throw new NexusError("INVALID_REQUEST", "Authentication configuration is incomplete");
      }
      return {
        digest: digest(secret.reveal()),
        tenant: Object.freeze({
          credentialId: reference.id,
          tenantId: tenant.id,
          allowedModels: new Set(tenant.allowedModels),
        }),
      };
    });
  }

  authenticate(header: string | ReadonlyArray<string> | undefined): AuthenticatedTenant {
    const value = typeof header === "string" ? header : undefined;
    const match = value?.match(/^Bearer ([^\s]+)$/);
    if (match === undefined || match === null || match[1] === undefined) {
      throw new NexusError("AUTHENTICATION_FAILED", "A valid bearer token is required");
    }
    const candidate = digest(match[1]);
    let authenticated: AuthenticatedTenant | undefined;
    for (const credential of this.#credentials) {
      if (timingSafeEqual(candidate, credential.digest)) authenticated = credential.tenant;
    }
    if (authenticated === undefined) {
      throw new NexusError("AUTHENTICATION_FAILED", "A valid bearer token is required");
    }
    return authenticated;
  }

  authorizeModel(tenant: AuthenticatedTenant, alias: string): void {
    if (!tenant.allowedModels.has(alias)) {
      throw new NexusError(
        "FORBIDDEN",
        `Tenant '${tenant.tenantId}' is not authorized for model '${alias}'`,
      );
    }
  }
}
