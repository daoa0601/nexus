# Nexus architecture

Nexus has a reusable core beneath a small Node HTTP server. Startup strictly decodes configuration,
resolves environment-secret references into non-serializing secret wrappers, builds a static public
model catalog, and initializes one generic OpenAI-compatible adapter per configured provider.

For each accepted `/v1/chat/completions` request, the server creates one root deadline and abort
controller before authentication and body decoding. Authentication resolves a bearer credential to a
tenant; the tenant's allowlist is checked before routing. The gateway resolves the public alias to an
immutable ordered target list. The executor then uses sequential retryable fallback, or opt-in
non-streaming hedging. A hedge waits for the first success, aborts losers, and waits for their terminal
ledger states. Streaming always uses sequential pre-content fallback and pins the selected route as
soon as the first text delta is emitted.

The OpenAI-compatible adapter receives the complete normalized message history, the concrete model,
the remaining deadline, and an `AbortSignal`. It maps only controlled fields from successful JSON or
SSE responses. It never returns an upstream error body. The downstream SSE writer honors Node stream
backpressure and emits `chat.completion.chunk` records followed by `data: [DONE]`.

An in-memory attempt ledger records every started provider attempt with request/tenant IDs, public and
concrete models, provider, latency, terminal outcome, classified failure, and authoritative usage when
present. Prompt and response content are not ledger fields. `close()` stops admission, aborts active
root scopes, closes listener connections within the configured grace period, and closes adapters.

Nexus remains below Agent Blocks. It performs transport policy only; orchestration, candidate selection,
worktrees, evaluation, persistence, and budgets belong to the orchestrator.

The server imports bounded request-body, strict JSON, and hardened JSON-response mechanics from
`@agentic-orch/node-guardrails/http`. Tenant credential lookup, hashed multi-tenant authentication, route
policy, streaming, deadlines, and error redaction remain Nexus-owned. Repository quality mechanics
come from exact-pinned `@agentic-orch/ts-quality`; neither shared package owns gateway policy.

## Managed catalog gateways

A managed catalog gateway is a possible upstream, not a replacement for Nexus's inbound boundary.
In that profile, Nexus keeps tenant authentication, allowlists, stable aliases, validation,
deadlines, cancellation, and its redacted dispatch ledger. The managed gateway owns selection and
fallback among providers in its catalog. Local, private, unsupported, offline, or explicitly
versioned deterministic routes remain direct Nexus targets.

Only one layer may own fan-out. A managed-gateway alias should resolve to one Nexus target and must
start exactly one target attempt: it must not use Nexus fallback or hedging. Otherwise one logical
request can multiply across Nexus and the managed gateway. The Nexus ledger records the one dispatch
to that target. Provider attempts hidden behind the target are separate nested facts and must not be
presented as Nexus attempts. A later caller resubmission receives a new request identity and is new
potentially billable work, not another target attempt of the original request.

The caller authenticates to Nexus, Nexus authenticates to the managed gateway, and the managed
gateway authenticates to its selected provider. The second credential is a Vercel AI Gateway API key
or OIDC token; the third may be a Vercel-managed provider credential or provider BYOK. They are
different secrets with different authorities and must not be conflated or forwarded across layers.

No managed-gateway adapter or AgentTrace exporter exists today. Any future adapter must pass the
same contract, cancellation, error-redaction, streaming, and bounded-response tests as a direct
provider, and should preserve documented resolved-provider metadata for correlation. See
[`MANAGED_GATEWAYS.md`](./MANAGED_GATEWAYS.md) for the full decision and operating profiles.
