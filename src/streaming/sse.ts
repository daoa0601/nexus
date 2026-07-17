import type { ServerResponse } from "node:http";

import { ClientDisconnectReason } from "../errors.js";

const waitForDrain = (response: ServerResponse, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new ClientDisconnectReason());
    };
    const onError = (): void => {
      cleanup();
      reject(new ClientDisconnectReason());
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new ClientDisconnectReason());
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const writeSseData = async (
  response: ServerResponse,
  value: unknown,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted || response.destroyed) throw signal.reason ?? new ClientDisconnectReason();
  const data = typeof value === "string" ? value : JSON.stringify(value);
  if (!response.write(`data: ${data}\n\n`)) {
    await waitForDrain(response, signal);
  }
};
