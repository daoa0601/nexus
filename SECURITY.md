# Nexus security model

Nexus binds to the configured address (`127.0.0.1` in the example) and requires bearer authentication
for every `/v1/*` route. Tokens and provider API keys are referenced by environment-variable name.
Resolved values are wrapped so string conversion, inspection, and JSON serialization are redacted.
Operators must still protect the process environment and configuration file permissions.

The server enforces body bytes, message count, total content characters, requested output tokens,
global request concurrency, provider concurrency, one request deadline, and provider attempt timeouts.
Unknown JSON and configuration fields fail closed. Model authorization precedes provider routing.
Inbound authorization and arbitrary caller headers are never forwarded; adapters construct a minimal
provider header set.

HTTPS is required for non-loopback upstreams. Plain HTTP is allowed only when both the hostname is
syntactically loopback and `allowLoopbackHttp: true` is configured, which is suitable for a local
Ollama-compatible endpoint. Nexus does not execute agent runtimes, shell commands, or other
subprocesses. It has no direct-provider bypass route.

Client-visible errors contain stable Nexus codes and request IDs. They exclude provider bodies,
bearer tokens, API keys, prompts, and completions. The default attempt ledger likewise excludes text.
Production deployments should terminate TLS before Nexus, restrict network reachability, inject
secrets through the platform secret facility, and export only the redacted structured ledger fields.
