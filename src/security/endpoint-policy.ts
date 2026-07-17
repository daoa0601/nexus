import { NexusError } from "../errors.js";

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part))
  );
};

export const validateProviderEndpoint = (
  rawUrl: string,
  allowLoopbackHttp: boolean,
  path: string,
): string => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NexusError("INVALID_REQUEST", `${path} must be an absolute URL`);
  }

  if (url.username !== "" || url.password !== "") {
    throw new NexusError("INVALID_REQUEST", `${path} must not contain credentials`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new NexusError("INVALID_REQUEST", `${path} must not contain a query or fragment`);
  }
  if (url.protocol === "https:") {
    return url.toString().replace(/\/$/, "");
  }
  if (url.protocol !== "http:") {
    throw new NexusError(
      "INVALID_REQUEST",
      `${path} must use HTTPS or explicitly allowed loopback HTTP`,
    );
  }
  if (!allowLoopbackHttp || !isLoopbackHostname(url.hostname)) {
    throw new NexusError("INVALID_REQUEST", `${path} rejects insecure non-loopback HTTP`);
  }
  return url.toString().replace(/\/$/, "");
};
