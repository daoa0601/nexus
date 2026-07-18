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

## Managed gateway trust boundary

A hosted AI gateway adds another processor, credential, billing boundary, and failure domain. It
must be reviewed as an external upstream even when it exposes an OpenAI-compatible protocol. Nexus
must replace the inbound bearer credential with a dedicated Vercel AI Gateway API key or OIDC token,
retain the existing HTTPS and header-minimization rules, and keep prompts, completions, credentials,
and raw upstream errors out of its ledger. Vercel then authenticates to the selected hosting
provider with either its managed provider credential or an explicitly configured provider BYOK
credential. The Nexus tenant bearer, AI Gateway credential, and provider credential are three
different secrets and must never substitute for or leak into one another.

Managed controls such as provider/model allowlists, Zero Data Retention, no-prompt-training policy,
and BYOK do not remove the need to verify the active plan, model-specific exclusions, provider
terms, regional requirements, and the operator's own BYOK agreements. Do not enable a managed
gateway for sensitive traffic until that review is complete. No managed-gateway integration is
currently shipped; see [`MANAGED_GATEWAYS.md`](./MANAGED_GATEWAYS.md) for the proposed boundary and
official references.
