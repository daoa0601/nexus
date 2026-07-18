# Managed AI gateway boundary

This document defines where a managed catalog gateway such as
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) could fit beside Nexus.
It is an architecture decision, not a supported integration: Nexus does not
currently ship a Vercel-specific adapter, configuration profile, metadata
decoder, or contract test.

The Vercel facts and links below were checked on 2026-07-18. Recheck them before
an implementation because model catalogs, routing controls, plan availability,
and data-handling terms change independently of Nexus.

## Build-versus-buy boundary

Vercel AI Gateway provides a unified hosted endpoint for its supported model
catalog, along with managed provider routing, fallbacks, gateway
authentication, provider BYOK, spend monitoring, and provider metadata. Its
default provider choice is dynamic; request options can restrict, order, or
sort the eligible providers.

Nexus remains useful where policy must be local, versioned, or independent of a
managed catalog:

| Concern                                                                    | Owner in a managed deployment                    |
| -------------------------------------------------------------------------- | ------------------------------------------------ |
| Inbound tenant authentication and model allowlists                         | Nexus                                            |
| Stable public aliases and the accepted request surface                     | Nexus                                            |
| One root deadline, cancellation, response bounds, and redacted errors      | Nexus                                            |
| Nexus-to-Vercel authentication with an AI Gateway API key or OIDC token    | Nexus                                            |
| Routing among providers in the Vercel catalog                              | Vercel AI Gateway                                |
| Managed provider credentials or explicitly configured provider BYOK        | Vercel AI Gateway                                |
| Hosted availability routing and spend views                                | Vercel AI Gateway                                |
| Local Ollama-compatible, private, or other explicitly configured endpoints | Nexus direct targets                             |
| Deterministic routing among targets explicitly declared equivalent         | Nexus direct targets                             |
| Durable traces, evaluation evidence, and cross-service correlation         | AgentTrace, after instrumentation is implemented |

This design treats Vercel as a catalog-backed upstream. It does not assume that
arbitrary Nexus or local endpoints can be registered in Vercel's catalog.
Unsupported, private, and offline targets continue to use Nexus directly.

## One layer owns fan-out

A logical request must have exactly one retry/fallback owner. For a future
Vercel-backed alias:

- configure exactly one Nexus target for the managed gateway, so Nexus performs
  exactly one target attempt and never retries or hedges managed-gateway
  requests;
- let Vercel own provider selection and provider/model fallback inside that
  dispatch;
- do not add an application or Observer retry loop around the same call unless
  the operation is explicitly safe to repeat and the extra billable work is
  accepted; and
- keep the Nexus deadline above the complete managed-gateway operation, while
  remembering that cancellation does not guarantee an upstream provider did
  not bill work already started.

The Nexus attempt ledger would record the dispatch to the configured managed
gateway target. Any provider attempts performed behind that endpoint are nested
managed-gateway facts, not automatically separate Nexus attempts. A future
adapter must preserve that distinction and capture documented gateway routing
metadata without treating it as Nexus's own attempt history.

If a caller submits again after that request completes, times out, or has an
uncertain outcome, Nexus creates a new request identity and a new logical
target attempt. That resubmission may cause new billable work; it must not be
folded into the first request's attempt history.

## Operating profiles

| Profile                 | Route policy                                                                                                                                                                                             | Evidence requirement                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production availability | One Nexus target delegates catalog routing to Vercel; use default routing or an explicit allowed provider set according to the product SLO.                                                              | Record the public alias, requested model, Nexus request/attempt IDs, gateway-resolved provider/model metadata, routing-policy version, usage, and credential class when exposed. |
| Controlled production   | One Nexus target; restrict and order the eligible Vercel providers. Avoid dynamic sorting if the route must be explainable from a fixed policy.                                                          | Record the exact provider options and returned routing metadata.                                                                                                                 |
| Reproducible benchmark  | Prefer one direct Nexus target. If the managed gateway is required, pin an exact model, restrict routing to one provider, disable model fallbacks and outer retries, and make caching behavior explicit. | Treat a run as invalid when the resolved provider/model or routing metadata is missing or differs from the benchmark manifest.                                                   |

Provider identity still does not make stochastic generation deterministic. A
benchmark manifest must also pin request parameters, prompt and dataset
digests, code revision, timeout policy, and any provider-visible feature or
service tier.

## Correlation and AgentTrace

No Nexus-to-AgentTrace exporter exists today. A future integration should emit
derived spans rather than replace the operational attempt ledger. The same
logical call should carry:

- one externally safe correlation ID across the caller, Nexus, and AgentTrace;
- separate Nexus attempt IDs and any gateway/provider request identifiers;
- requested public alias and concrete gateway model;
- resolved provider and provider API model from gateway metadata;
- the exact local and managed routing-policy versions; and
- authoritative provider/gateway usage separately from local estimates.

Prompts and completions must remain opt-in trace fields. Correlation identifiers
must not contain tenant secrets, bearer credentials, or prompt data.

## Security and procurement

Adding a managed gateway adds a network hop, credential, data processor, hosted
control plane, and billing system. The deployment review must cover data
classification, regional requirements, incident response, availability,
provider terms, and how Vercel's terms interact with every selected provider.

The credential chain has three separate roles:

1. The caller presents a Nexus tenant bearer to Nexus.
2. Nexus replaces it with a Vercel AI Gateway API key or OIDC token when
   authenticating the outbound gateway request.
3. Vercel authenticates to the resolved hosting provider with its managed
   credential or an explicitly configured team- or request-level provider
   BYOK credential.

Never forward the caller bearer to Vercel or a provider. A provider BYOK key is
not a Vercel AI Gateway credential, and neither credential should be exposed to
the caller, ledger, errors, or traces.

Vercel documents team- and request-level Zero Data Retention, no-prompt-training
controls, provider/model allowlists, AI Gateway API keys/OIDC, and provider
BYOK. Those controls are useful policy inputs, not proof that a particular
request satisfies this project's obligations. Confirm the active plan,
model-specific exclusions, and BYOK agreements before sending sensitive data.

## Official Vercel references

- [AI Gateway overview](https://vercel.com/docs/ai-gateway)
- [Models and providers](https://vercel.com/docs/ai-gateway/models-and-providers)
- [Provider filtering, ordering, and sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)
- [Model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks)
- [Provider timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts)
- [Authentication and BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok)
- [Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability)
- [Zero Data Retention](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr)
- [Disallow prompt training](https://vercel.com/docs/ai-gateway/security-and-compliance/disallow-prompt-training)
