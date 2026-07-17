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

Nexus remains below Aiur. It performs transport policy only; orchestration, candidate selection,
worktrees, evaluation, persistence, and budgets belong to the orchestrator.
