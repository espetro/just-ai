import { H3Event } from 'h3';
import { Storage } from 'unstorage';
import { LanguageModelV4 } from '@ai-sdk/provider';

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
    top_p?: number;
    top_k?: number;
    seed?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    stop?: string | string[];
    response_format?: unknown;
    tools?: unknown[];
    tool_choice?: unknown;
    stream_options?: {
        include_usage?: boolean;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}
/** Read-only view of secrets/env across runtimes (CF bindings, process.env). */
interface EnvAccess {
    get(name: string): string | undefined;
    /** Raw platform bindings (CF `env`) when present — for AI/ratelimit bindings. */
    cfEnv?: Record<string, unknown>;
}
/**
 * Deployment-supplied provider factory — the extension seam for lanes that
 * aren't built in. Build a LanguageModelV4 for a lane; return value feeds
 * the shared dispatch + OpenAI-wire emitter.
 */
interface ModelFactory {
    /** Env var consulted for the API key unless LaneSpec.keyEnv overrides. */
    keyEnv?: string;
    /** Lane can run without any secret (platform bindings). */
    keyless?: boolean;
    create(ctx: GatewayContext, spec: LaneSpec, apiKey?: string): LanguageModelV4;
}
/** Per-lane outcome — emitted via `onLaneAttempt` after each lane dispatch. */
interface LaneAttemptInfo {
    alias: string;
    provider: string;
    model: string;
    outcome: "ok" | "skipped_unavailable" | "skipped_circuit" | "failed" | "client_error";
    status?: number;
    latencyMs?: number;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
    };
}
/** Emitted once via `onRequestDone` when the proxy step finishes. */
interface RequestDoneInfo {
    alias: string;
    /** Winning lane's provider, if any. */
    provider?: string;
    attempts: number;
    latencyMs: number;
    status: number;
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
    /** Deployment provider factories, shadowing built-ins. */
    providers?: Record<string, ModelFactory>;
    /** Observability hooks — never prompt content, only lane metadata. */
    onLaneAttempt?: (ctx: GatewayContext, info: LaneAttemptInfo) => void;
    onRequestDone?: (ctx: GatewayContext, info: RequestDoneInfo) => void;
}
/**
 * Pipeline step: return a Response to short-circuit (preflight, errors,
 * final proxy) or void to continue.
 */
type Step = (ctx: GatewayContext) => Promise<Response | void>;

export type { ChatRequest as C, EnvAccess as E, GatewayProfile as G, LaneSpec as L, ModelFactory as M, RateWindow as R, Step as S, GatewayContext as a, ModelRoute as b, ChatMessage as c, LaneAttemptInfo as d, RequestDoneInfo as e };
