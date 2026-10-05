import { H3Event } from 'h3';
import { Storage } from 'unstorage';
import { G as GatewayProfile, S as Step, M as ModelFactory, a as GatewayContext, b as ModelRoute, E as EnvAccess, R as RateWindow, L as LaneSpec, C as ChatRequest } from './shared/gateway.Borrsgya.mjs';
export { c as ChatMessage, d as LaneAttemptInfo, e as RequestDoneInfo } from './shared/gateway.Borrsgya.mjs';
import { LanguageModelV4, LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';

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
    /**
     * Deployment provider factories shadowing built-ins — lane `provider`
     * names map to LanguageModelV4 factories (see ModelFactory). The plug
     * seam for providers we don't ship.
     */
    providers?: Record<string, ModelFactory>;
    /**
     * Observability hooks — called with lane metadata only (never prompt
     * content): wire to console.log, KV counters, Analytics Engine, OTel…
     */
    onLaneAttempt?: GatewayContext["onLaneAttempt"];
    onRequestDone?: GatewayContext["onRequestDone"];
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

declare const OPENAI_COMPAT_PRESETS: Record<string, {
    baseUrl: string;
    keyEnv: string;
}>;
/** Built-in factories. Unknown provider + explicit baseUrl → openai-compat. */
declare const builtinFactories: Record<string, ModelFactory>;
interface ResolvedModel {
    model: LanguageModelV4;
    /** Env var name the key came from (for diagnostics — never the value). */
    keyEnv?: string;
}
/**
 * Resolve a lane to a LanguageModel, or undefined when it can't run here
 * (missing key, missing binding) — the failover chain just skips it.
 * `custom` factories (createGateway providers option) shadow built-ins.
 */
declare function resolveModel(ctx: GatewayContext, spec: LaneSpec, custom?: Record<string, ModelFactory>): ResolvedModel | undefined;

/**
 * Single OpenAI-wire emitter for every provider lane — this is the only
 * place upstream output becomes `chat.completion` / `chat.completion.chunk`.
 * Provider ids never reach the wire: `model` in payloads is the public alias.
 */
interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
}
interface EmitOpts {
    /** Public alias — what the client asked for. */
    alias: string;
    id: string;
    created: number;
    /** Client requested usage chunks (stream_options.include_usage). */
    sendUsage: boolean;
    /** Fires once with final usage + finish reason, after the stream ends. */
    onDone?: (info: {
        usage?: TokenUsage;
        finishReason?: string;
    }) => void;
}
/**
 * LanguageModelV4 stream → OpenAI SSE stream. Text, reasoning (as
 * `reasoning_content`, the DeepSeek/OpenRouter convention), complete
 * tool calls, finish_reason, and terminal usage are mapped; provider
 * metadata / structural parts are dropped.
 */
declare function streamToOpenAiSse(upstream: ReadableStream<LanguageModelV4StreamPart>, opts: EmitOpts): ReadableStream<Uint8Array>;
/** LanguageModelV4 generate result → OpenAI `chat.completion` JSON. */
declare function generateToOpenAiJson(result: LanguageModelV4GenerateResult, opts: {
    alias: string;
    id: string;
    created: number;
}): {
    body: Record<string, unknown>;
    usage?: TokenUsage;
};

/** Failure surfaced to the proxy step for failover decisions. */
declare class LaneError extends Error {
    /** Upstream HTTP status when known (APICallError), else undefined. */
    status?: number;
    /** Raw upstream error body for pass-through (4xx that isn't failover). */
    body?: string;
    constructor(message: string, status?: number, cause?: unknown);
}
interface LaneDispatch {
    response: Response;
    /** Usage seen at emit time (streams report async — see onDone). */
    usage?: TokenUsage;
}
/**
 * Resolve + dispatch one lane. Throws LaneError on failure BEFORE a response
 * is committed — the proxy step maps `status` to a failover decision.
 * `doGenerate`/`doStream` resolving = upstream answered = commit point.
 */
declare function dispatchLane(ctx: GatewayContext, spec: LaneSpec, body: ChatRequest, opts?: {
    model?: LanguageModelV4;
    onDone?: (info: {
        usage?: TokenUsage;
        finishReason?: string;
    }) => void;
}): Promise<LaneDispatch>;
/**
 * Canned probe for a single lane — admin test endpoint and CLI share this.
 * Bypasses failover entirely so the result is this lane's own verdict.
 */
declare function probeLane(ctx: GatewayContext, spec: LaneSpec): Promise<{
    ok: boolean;
    status?: number;
    latencyMs: number;
    error?: string;
}>;

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
 * Provider failover + OpenAI-wire passthrough. THE critical constraint: a
 * lane is committed when `doGenerate`/`doStream` resolves — upstream
 * answered — and the emitted stream is handed through untouched; retry is
 * then impossible. dispatchLane throws LaneError before the commit point.
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

export { ChatRequest, EnvAccess, GatewayContext, GatewayProfile, LaneError, LaneSpec, ModelFactory, ModelRoute, OPENAI_COMPAT_PRESETS, RateWindow, Step, allLanesDown, badRequest, builtinFactories, cfBindingLimiter, circuitBreaker, createEnvAccess, createGateway, createRateLimiter, defaultSteps, defineGatewayProfile, dispatchLane, forbidden, gatewayError, generateToOpenAiJson, getClientIp, memoryLimiter, modelsList, parseModelsJson, probeLane, rateLimited, resolveModel, runPipeline, index as steps, streamToOpenAiSse, unstorageLimiter };
export type { GatewayOptions, RateLimitResult, RateLimiter, ResolvedModel };
