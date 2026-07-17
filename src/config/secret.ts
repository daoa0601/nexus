import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return "SecretValue([REDACTED])";
  }
}

export interface RuntimeSecrets {
  readonly inboundTokens: ReadonlyMap<string, SecretValue>;
  readonly providerApiKeys: ReadonlyMap<string, SecretValue>;
}
