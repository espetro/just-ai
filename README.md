# just-ai

A runtime-agnostic AI gateway for front-of-demo LLM endpoints:
OpenAI-compatible `POST /v1/chat/completions` with SSE streaming, provider
failover, IP rate limiting, bot gating, and request clamping — built on unjs
(`nitro`, `h3`, `ofetch`, `unstorage`), so the same code deploys to
Cloudflare Workers, Node, Bun, Deno, Vercel, ...

```
just-ai/
├── packages/gateway/   @just-ai/gateway — the portable core
│   └── src/            pipeline, steps, providers, ratelimit, circuit, env
├── template/           a generic deployment app — copy it, edit profiles +
│                       wrangler.jsonc, set secrets, deploy
└── tests               (in packages/gateway/tests)
```

## Two ways to reuse

**A. Copy the template** (`template/` → your deployment repo): fastest for a
one-off; you own a full app with placeholder config.

**B. Install the package** and write the 10 lines of wiring yourself:

```jsonc
// package.json
"dependencies": {
  "@just-ai/gateway": "github:espetro/just-ai#path:/packages/gateway"
}
```

```ts
// server/routes/v1/chat/completions.ts
import { createGateway } from "@just-ai/gateway";
import { myProfile } from "../../profiles/my";

export default defineEventHandler(
  createGateway({
    profile: myProfile,                    // or (event) => profileFor(event)
    storage: () => useStorage("ratelimit"),
  }),
);
```

## The profile model — where projects wire in

Everything project-specific is one `GatewayProfile` object
(`defineGatewayProfile` in `server/profiles/`): allowed origins, bot-gate
settings, rate-limit windows + store, clamp ceilings, and `models`:
**public alias → ordered provider lanes**. Upstream provider ids never reach
the wire — clients ask for `chat` and get whatever lane answered.

```ts
models: {
  chat: {
    lanes: [
      { provider: "groq",   model: "openai/gpt-oss-120b" },
      { provider: "zai",    model: "glm-4.7-flash" },
      { provider: "google", model: "gemini-2.5-flash-lite" },
      { provider: "cf-ai",  model: "@cf/meta/llama-3.2-3b-instruct" },
    ],
  },
}
```

`openaiCompat` covers any OpenAI-shaped endpoint (Groq, Z.ai, Google's
OpenAI shim, OpenRouter — or a custom `baseUrl`). `cf-ai` uses the Workers
AI binding and silently deactivates off-Cloudflare.

## Pipeline

`cors → origin → botGate → rateLimit → clamp → failover → SSE`

- **Failover resolves before streaming** — a lane is committed when the
  upstream response resolves `ok`; mid-stream errors cannot retry.
- `ofetch` `retry: 0` — retries exist only at lane granularity.
- Non-429 4xx from a lane passes straight through (client's problem, not the
  provider's).
- Circuit breaker: ≥3 consecutive lane failures → lane skipped 60s globally
  (shared storage mount).
- Rate limiting: `RateLimiter` interface — native CF `ratelimits` binding,
  or fixed-window counters on the shared unstorage mount (`kv`/`redis`/
  `upstash`/`memory` drivers, swappable by preset).
- Never `console.log` prompts; env/secrets are only read per-request (CF
  binds them inside the request lifecycle).

## Publishing `@just-ai/gateway` later

The package is already npm-shaped (`files: ["dist"]`, `unbuild` →
`dist/index.mjs` + `.d.ts`, `prepare` builds on git-dep install). To publish:
`pnpm --filter @just-ai/gateway publish --access public` (plus an
`NPM_TOKEN` release workflow). Consumers then switch the dep spec from
`github:...#path:` to a semver.

## Develop

```sh
pnpm install          # runs unbuild (prepare) + nitro prepare in template
pnpm build            # gateway dist + template .output
pnpm test             # gateway unit tests (no CF bindings needed)
pnpm typecheck
```
