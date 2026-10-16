# Nexus

Nexus is a Node.js/TypeScript/Effect v4 transport gateway. It exposes a deliberately small,
authenticated OpenAI-compatible text-chat API and routes public model aliases only to targets that an
operator has explicitly declared equivalent.

Nexus is not an agent runtime. It does not run shell commands, invoke agentic CLIs, construct helper
prompts, evaluate candidates, or manage harness budgets.

## Credentials

Nexus upstreams use provider API credentials referenced by environment-variable name in the Nexus
configuration. A ChatGPT subscription is not an OpenAI API credential and is never copied into Nexus.
Callers authenticate with a Nexus tenant bearer, which is never forwarded upstream.

## Managed gateway boundary

A hosted catalog gateway such as Vercel AI Gateway may eventually be configured as one Nexus
upstream. No such integration ships today. Such an alias must resolve to exactly one Nexus target
with no Nexus fallback or hedging, so one logical request starts exactly one Nexus target attempt.
See [`MANAGED_GATEWAYS.md`](./MANAGED_GATEWAYS.md) for the configuration rules, operating profiles,
attempt-ledger semantics, credential chain, and official Vercel references. Which layer owns
retries and fallback across the other repositories is set in the catalog README.

## Run the gateway

Nexus requires a supported Node.js release and pnpm 11.13.1.

```bash
pnpm install --frozen-lockfile
export NEXUS_CLIENT_TOKEN='replace-with-a-long-random-token'
export OPENAI_API_KEY='your-provider-api-key'
pnpm build
node ./dist/cli.js --config ./examples/nexus.example.yaml
```

The package `bin` exposes the same CLI as `nexus`:

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

See [QUALITY.md](QUALITY.md) for the pinned pnpm, coverage, dependency, secret, and local-hook
gates.

This repository needs `node-guardrails` and `ts-quality` checked out next to it; see the catalog
README for the sibling layout. The lock resolves both as `link:` entries, so a missing sibling fails
the frozen install instead of falling back to a registry, and `pnpm install` builds
`node-guardrails` through its `prepare` script.

Tests use fake adapters and loopback fixture servers; they do not call billable provider APIs.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`SECURITY.md`](./SECURITY.md), and
[`MANAGED_GATEWAYS.md`](./MANAGED_GATEWAYS.md) for the service boundary, cancellation, telemetry,
managed-gateway, and security contracts.
