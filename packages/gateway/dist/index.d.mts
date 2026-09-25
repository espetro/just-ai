import { H3Event } from 'h3';
import { Storage } from 'unstorage';

/** Public alias → ordered provider failover chain. */
interface ModelRoute {
    lanes: LaneSpec[];
}
interface LaneSpec {
    /** Registry key of a provider adapter (groq, zai, google, openrouter, cf-ai). */
    provider: string;
    /** Upstream model id sent to the provider. */
    model: string;
    /** Override adapter default base URL. */
    baseUrl?: string;
    /** Override env var name holding the API key. */
    keyEnv?: string;
}
interface RateWindow {
    /** Logical name — becomes part of the storage key. */
    name: string;
    limit: number;
    windowSec: number;
}
interface GatewayProfile {
    name: string;
    /** Exact origins or `*.suffix` wildcards. Requests without an Origin pass (curl, server-to-server). */
    origins: string[];
    cors?: {
        allowHeaders?: string[];
        maxAge?: number;
    };
    botGate: {
        type: "turnstile" | "none";
        /** Env var holding the Turnstile secret. */
        secretEnv?: string;
        /** Header carrying the token (default: cf-turnstile-token). */
        header?: string;
        /** siteverify `hostname` must be one of these. */
        allowedHostnames?: string[];
    };
    rateLimit: {
        keyStrategy: "ip" | "apiKey";
        /** Backend: native CF binding, the shared unstorage mount, or in-memory. */
        store: "cf-binding" | "storage" | "memory" | "auto";
        windows: RateWindow[];
    };
    clamp: {
        maxTokens: number;
        maxPromptBytes: number;
        maxMessages: number;
        stream?: boolean;
    };
    models: Record<string, ModelRoute>;
}
interface ChatMessage {
    role: string;
    content: unknown;
}
interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    [k: string]: unknown;
}
/** Read-only view of secrets/env across runtimes (CF bindings, process.env). */
interface EnvAccess {
    get(name: string): string | undefined;
    /** Raw platform bindings (CF `env`) when present — for AI/ratelimit bindings. */
    cfEnv?: Record<string, unknown>;
}
interface GatewayContext {
    event: H3Event;
    profile: GatewayProfile;
    env: EnvAccess;
    /** unstorage mount for ratelimit counters + circuit breakers. */
    storage: Storage;
    requestId: string;
    clientIp: string;
    /** Parsed, clamped request body — set by the clamp step. */
    body?: ChatRequest;
}
/**
 * Pipeline step: return a Response to short-circuit (preflight, errors,
 * final proxy) or void to continue.
 */
type Step = (ctx: GatewayContext) => Promise<Response | void>;

declare const defaultSteps: Step[];
interface GatewayOptions {
    /**
     * The profile this deployment serves — a static GatewayProfile for one
     * project, or a resolver (sync or async) for per-request selection:
     * multi-tenant dispatch on Host/API key/path, or merging remote config
     * (e.g. a KV-hosted model map via parseModelsJson).
     */
    profile: GatewayProfile | ((event: H3Event) => GatewayProfile | Promise<GatewayProfile>);
    /**
     * Storage for rate-limit counters + circuit breakers. In nitro apps pass
     * `() => useStorage("<mount>")` — resolved lazily inside the request
     * lifecycle, where nitro makes bindings available.
     */
    storage: Storage | ((event: H3Event) => Storage);
    /** Ordered pipeline steps; defaults to the full security chain. */
    steps?: Step[];
}
/**
 * Handler factory — returns an h3-compatible handler suitable for
 * `defineEventHandler(createGateway({...}))` in a nitro route file, or any
 * server that dispatches Fetch/H3 events.
 */
declare function createGateway(opts: GatewayOptions): (event: H3Event) => Promise<Response>;

/**
 * Identity helper for profile files — gives you editor-time type checking and
 * a stable place to hang future profile normalization.
 */
declare function defineGatewayProfile(profile: GatewayProfile): GatewayProfile;

/** OpenAI-shaped /v1/models payload — public aliases only, lanes never exposed. */
declare function modelsList(profile: GatewayProfile): {
    object: "list";
    data: {
        id: string;
        object: "model";
        created: number;
        owned_by: string;
    }[];
};

/**
 * Validate a JSON model map (public alias → lanes) loaded from config —
 * e.g. a KV key or env var — into the profile's `models` shape.
 * Throws on malformed input so config errors surface loudly at load time.
 */
declare function parseModelsJson(input: unknown): Record<string, ModelRoute>;

/**
 * Ordered request pipeline. Each step either returns a Response to
 * short-circuit (preflight answer, rejection, final proxied response) or void
 * to continue. Order is security-cheap-first:
 *
 *   cors → origin → botGate → rateLimit → clamp → proxy(failover)
 *
 * Turnstile runs before rate limiting because siteverify costs a subrequest
 * and tokens are single-use; a rejected bot should not consume user quota.
 */
declare function runPipeline(ctx: GatewayContext, steps: Step[]): Promise<Response>;

/**
 * Portable env/secret access. Nitro bridges platform env vars (including
 * `wrangler secret` values) into `process.env` *inside the request lifecycle*;
 * we also fall back to the raw CF `env` binding object for binding-only values.
 * NEVER read env vars at module scope — CF only binds them per-request.
 */
declare function createEnvAccess(event: H3Event): EnvAccess;
/** Client IP: CF header first, then standard fallbacks. Portable. */
declare function getClientIp(event: H3Event): string;

/**
 * Tiny circuit breaker on the shared unstorage mount. After `threshold`
 * consecutive dispatch failures a lane is skipped until `cooldownSec` elapses.
 * State is deliberately approximate — a lane that trips on one isolate may
 * still serve another on weakly-consistent backends; that's fine for failover.
 */
declare function circuitBreaker(storage: Storage, opts?: {
    threshold?: number;
    cooldownSec?: number;
}): {
    isOpen(lane: string): Promise<boolean>;
    recordSuccess(lane: string): Promise<void>;
    recordFailure(lane: string): Promise<void>;
};

interface RateLimitResult {
    success: boolean;
    /** Seconds until the denied window resets. */
    retryAfter: number;
}
/**
 * Rate limiter contract. Implementations:
 *  - cf-binding: native `ratelimits` binding — unmetered, edge-exact, but the
 *    window is fixed in wrangler config and CF-only.
 *  - storage: fixed-window counter on the shared unstorage mount — works on
 *    any driver (KV/Redis/Upstash/memory). Atomicity depends on the driver:
 *    exact on Redis/Upstash, approximate on CF KV (documented trade-off).
 *  - memory: dev/tests only — per-isolate, resets on cold start.
 */
interface RateLimiter {
    limit(key: string, window: RateWindow): Promise<RateLimitResult>;
}
declare function createRateLimiter(ctx: GatewayContext): RateLimiter;

/**
 * Fixed-window counter on any unstorage driver.
 *
 * get+set is not atomic, so on eventually-consistent backends (CF KV) a burst
 * can overshoot the limit slightly — acceptable for demo abuse control; use
 * the `redis`/`upstash` driver (atomic INCR) or the native `cf-binding` impl
 * when exactness matters.
 */
declare function unstorageLimiter(storage: Storage): RateLimiter;
/** Per-isolate store — counters are shared across requests on one isolate. */
declare function memoryLimiter(): RateLimiter;

interface CfRateLimitBinding {
    limit(opts: {
        key: string;
    }): Promise<{
        success: boolean;
    }>;
}
/**
 * Native `ratelimits` binding — unmetered and edge-exact, but its window is
 * declared in wrangler config, so this impl ignores per-window profile values
 * (use exactly one RateWindow in the profile when store = cf-binding).
 * CF-only; skipped on other runtimes by createRateLimiter.
 */
declare function cfBindingLimiter(binding: CfRateLimitBinding): RateLimiter;

/**
 * A provider adapter turns a LaneSpec into a dispatchable upstream call.
 * Implementations must be constructible without secrets — env access happens
 * inside dispatch()/available() at request time.
 */
interface ProviderLane {
    /** Can this lane run here? (API key present, CF binding exists, ...) */
    available(ctx: GatewayContext, spec: LaneSpec): boolean;
    /**
     * Fire the upstream request and return the RAW response (possibly an
     * in-flight SSE stream). Callers must treat a resolved ok Response as
     * committed — no retry is possible once streaming starts.
     */
    dispatch(ctx: GatewayContext, spec: LaneSpec, body: ChatRequest): Promise<Response>;
}
/** Registry: lane spec → adapter. Unknown provider keys fall back to openai-compat. */
declare function resolveLane(spec: LaneSpec): ProviderLane;

/**
 * Any OpenAI-compatible `/chat/completions` endpoint. Covers Groq, Z.ai,
 * Google AI Studio (OpenAI shim), OpenRouter — and any future provider that
 * speaks the same wire format — with zero bespoke code.
 */
declare function openaiCompatLane(defaults: {
    baseUrl?: string;
    keyEnv?: string;
}): ProviderLane;

/**
 * Cloudflare Workers AI lane — the only adapter that is inherently CF-only
 * (it uses the `ai` binding). available() returns false elsewhere, so the
 * failover chain just skips it on other runtimes.
 */
declare const cfAiLane: ProviderLane;

declare function originAllowed(origin: string | undefined, allowed: string[]): boolean;
declare function corsHeaders(ctx: GatewayContext): Record<string, string>;
/** Answers preflights and stamps CORS headers on every downstream response. */
declare const corsStep: Step;

/**
 * First-party gate: browsers always send Origin on POST, so a disallowed
 * Origin is a hard reject. Missing Origin (curl/server) is allowed through —
 * those clients still face the bot gate + rate limit.
 */
declare const originStep: Step;

/**
 * Turnstile verification — a plain fetch, so this step is already
 * runtime-agnostic. Tokens are single-use and hostname-bound (checked against
 * profile.botGate.allowedHostnames).
 */
declare const botGateStep: Step;

/**
 * Per-IP (or per-API-key) fixed-window limiting, checked before the body is
 * even parsed — cheap reject. All profile windows are consumed; the first
 * exceeded window 429s with Retry-After.
 */
declare const rateLimitStep: Step;

/**
 * Parse + clamp the request body before any upstream call:
 *  - raw size cap (before JSON.parse, so huge bodies reject cheaply)
 *  - model must be a profile-declared public alias (upstream ids never leak in)
 *  - max_tokens clamped to the profile ceiling, messages array capped
 */
declare const clampStep: Step;

/**
 * Provider failover + SSE passthrough. THE critical constraint: a lane is
 * chosen and committed *before* any body bytes reach the client — once the
 * upstream Response resolves ok, its stream is handed through untouched and
 * retry is impossible.
 */
declare const proxyStep: Step;

declare const index_botGateStep: typeof botGateStep;
declare const index_clampStep: typeof clampStep;
declare const index_corsHeaders: typeof corsHeaders;
declare const index_corsStep: typeof corsStep;
declare const index_originAllowed: typeof originAllowed;
declare const index_originStep: typeof originStep;
declare const index_proxyStep: typeof proxyStep;
declare const index_rateLimitStep: typeof rateLimitStep;
declare namespace index {
  export {
    index_botGateStep as botGateStep,
    index_clampStep as clampStep,
    index_corsHeaders as corsHeaders,
    index_corsStep as corsStep,
    index_originAllowed as originAllowed,
    index_originStep as originStep,
    index_proxyStep as proxyStep,
    index_rateLimitStep as rateLimitStep,
  };
}

/** OpenAI-style error envelope so clients can reuse stock SDK error handling. */
declare function gatewayError(status: number, message: string, type: string, headers?: Record<string, string>): Response;
declare function rateLimited(retryAfter: number): Response;
declare function forbidden(message?: string): Response;
declare function badRequest(message: string): Response;
declare function allLanesDown(): Response;

export { allLanesDown, badRequest, cfAiLane, cfBindingLimiter, circuitBreaker, createEnvAccess, createGateway, createRateLimiter, defaultSteps, defineGatewayProfile, forbidden, gatewayError, getClientIp, memoryLimiter, modelsList, openaiCompatLane, parseModelsJson, rateLimited, resolveLane, runPipeline, index as steps, unstorageLimiter };
export type { ChatMessage, ChatRequest, EnvAccess, GatewayContext, GatewayOptions, GatewayProfile, LaneSpec, ModelRoute, ProviderLane, RateLimitResult, RateLimiter, RateWindow, Step };
