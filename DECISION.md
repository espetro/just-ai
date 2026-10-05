# Decision record — 2026-10-05

**Status: superseded. This repo is archived in favor of Cloudflare AI Gateway.**

## What this was

`@just-ai/gateway` — a minimal, self-hosted AI gateway for Cloudflare Workers:
OpenAI-shaped `/chat/completions` + `/v1/models`, ordered streaming failover
across provider lanes (Vercel AI SDK adapters), KV circuit breaker, GitOps
config (`models.json` → KV), read-only admin behind CF Access, and a
Node-stdlib-only `just-ai` CLI. Working, tested, CI-green. ~2.6k LOC.

## Why we stopped

Build-vs-buy eval (same day) concluded the layer is commodity:

- Cloudflare AI Gateway covers the requirements natively, free, on the same
  platform: BYOK provider keys, Custom Providers (any HTTPS base URL),
  dynamic routing (fallback/retries/timeouts/conditional/weights), caching,
  rate limiting, analytics — manageable via dashboard, REST, and Terraform
  (`cloudflare_ai_gateway_dynamic_routing`).
- Portkey-AI/gateway (MIT) is the only open-source option that also runs on
  Workers + locally, but its self-hosted routing config is per-request.
- All other OSS gateways (LiteLLM, Bifrost, TensorZero [archived 2026-06],
  Helicone [GPLv3], Higress) cannot run on Cloudflare Workers at all.

Maintaining this code meant owning every future API shape (`/responses`,
`/messages`), provider drift, and streaming edge case for plumbing our
platform vendor ships free.

## Where it went

The deployment (`just-ai-illo`) was replaced by a Cloudflare AI Gateway +
dynamic route setup documented in that repo's `DECISION.md`
(`config/ai-gateway-route.json`). The GitOps `models.json` UX survives as a
config → route-JSON publisher, not a runtime gateway.

## Kept for reference

The lane-commit streaming-failover semantics (`doGenerate`/`doStream`
promise-resolution = upstream headers arrived), deferred circuit-breaker
writes via `ctx.waitUntil`, and error-isolated observability hooks are
patterns worth reusing elsewhere — that's why this is archived, not deleted.
