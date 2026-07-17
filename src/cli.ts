#!/usr/bin/env node
import * as Effect from "effect/Effect";

import { loadConfigEffect } from "./config/load.js";
import { NexusError } from "./errors.js";
import { createNexusServer } from "./server/app.js";

const usage = "Usage: nexus --config <path>";

const configPathFrom = (arguments_: ReadonlyArray<string>): string => {
  if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  if (arguments_.length !== 2 || arguments_[0] !== "--config" || arguments_[1] === undefined) {
    throw new NexusError("INVALID_REQUEST", usage);
  }
  return arguments_[1];
};

const awaitShutdownSignal = (): Promise<NodeJS.Signals> =>
  new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });

const main = async (): Promise<void> => {
  const path = configPathFrom(process.argv.slice(2));
  const loadedConfig = await Effect.runPromise(loadConfigEffect(path));
  const server = createNexusServer({ loadedConfig });
  await server.listen();
  process.stdout.write(`Nexus listening at ${server.url ?? "configured address"}\n`);
  await awaitShutdownSignal();
  await server.close();
};

main().catch((error: unknown) => {
  const message = error instanceof NexusError ? error.message : "Nexus failed to start";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
