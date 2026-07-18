# Nexus

Nexus is a Node.js/TypeScript/Effect v4 transport gateway. It exposes a deliberately small,
authenticated OpenAI-compatible text-chat API and routes public model aliases only to targets that an
operator has explicitly declared equivalent.

Nexus is not an agent runtime. It does not run shell commands, invoke agentic CLIs, construct helper
prompts, evaluate candidates, or manage harness budgets.

## Credentials and the orchestration boundary

Agent Blocks and Templar use the ChatGPT-backed Codex CLI through the user's local Codex authentication.
Nexus upstreams use provider API credentials referenced by environment-variable name in the Nexus
configuration. A ChatGPT subscription is not copied into Nexus and is not an OpenAI API credential.

A future Vercel target would add a separate credential boundary. Callers would continue to present
their Nexus tenant bearer; Nexus would replace it with a Vercel AI Gateway API key or OIDC token for
the outbound request. Vercel would then use either its managed provider credentials or provider BYOK
credentials configured for that team or request. Those provider credentials are not the Nexus
caller bearer and are not the AI Gateway credential.

## Managed gateway boundary

A hosted catalog gateway such as Vercel AI Gateway may eventually be configured as one Nexus
upstream: Nexus would retain inbound authentication, public aliases, request validation, local or
private targets, and deterministic policy, while the hosted gateway would own routing within its
managed provider catalog. No such integration ships today. In particular, do not stack Nexus
fallback or hedging around a managed gateway that already performs provider retries and fallbacks.
Such an alias must start exactly one Nexus target attempt for one logical request. A later caller
resubmission is a new logical request and can create new billable work; it is not another attempt of
the first request.

See [`MANAGED_GATEWAYS.md`](./MANAGED_GATEWAYS.md) for the build-versus-buy boundary, production and
benchmark profiles, attempt-ledger semantics, AgentTrace correlation plan, security review, and
current official Vercel references.

## Run the gateway

Nexus requires a supported Node.js release and pnpm 11.13.1.

```bash
pnpm install --frozen-lockfile
export NEXUS_CLIENT_TOKEN='replace-with-a-long-random-token'
export OPENAI_API_KEY='your-provider-api-key'
pnpm build
node ./dist/cli.js --config ./examples/nexus.example.yaml
```

The installed package exposes the equivalent CLI:

```bash
nexus --config ./nexus.yaml
```

Library users can build the same policy-preserving core with `createNexusGateway({ config, secrets,
adapters })`. Concrete provider adapters and the registry are intentionally not package exports;
requests still resolve only through configured public aliases and targets.

Every `/v1/*` request needs its configured inbound bearer token:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $NEXUS_CLIENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"general-chat","messages":[{"role":"user","content":"Hello"}]}'
```

Supported routes are `POST /v1/chat/completions`, `GET /v1/models`, `GET /health/live`, and
`GET /health/ready`. Chat Completions supports string content with `system`, `developer`, `user`, and
`assistant` roles, plus `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, and
SSE streaming. Unknown fields and unsupported multimodal, tool, audio, and provider-specific options
are rejected.

## Configuration

See [`examples/nexus.example.yaml`](./examples/nexus.example.yaml). Configuration is strict: every
limit is explicit, unknown keys fail startup, aliases and IDs must be unique, referenced environment
secrets must exist, and insecure HTTP is accepted only for an explicitly allowed loopback endpoint.
Multiple targets are usable only when `equivalentTargets: true`. `fallback` is sequential and is the
default policy in the example; `hedge` is opt-in, non-streaming only, and requires explicit delay and
parallelism limits.

## Development

```bash
pnpm check
pnpm build
pnpm preflight
```

See [QUALITY.md](QUALITY.md) for the pinned pnpm, coverage, dependency, package, secret, and local-hook
gates.

The current manifest uses `workspace:*` for `@agentic-orch/node-guardrails` and
`@agentic-orch/ts-quality`; the lock resolves their sibling source trees. A frozen install therefore
requires those siblings and cannot fall back to registry packages. This is the intended local
topology.

Tests use fake adapters and loopback fixture servers; they do not call billable provider APIs.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`SECURITY.md`](./SECURITY.md), and
[`MANAGED_GATEWAYS.md`](./MANAGED_GATEWAYS.md) for the service boundary, cancellation, telemetry,
managed-gateway, and security contracts.
