import type { H3Event } from "h3";
import type { Storage } from "unstorage";

/** Public alias → ordered provider failover chain. */
export interface ModelRoute {
  lanes: LaneSpec[];
}

export interface LaneSpec {
  /** Registry key of a provider adapter (groq, zai, google, openrouter, cf-ai). */
  provider: string;
  /** Upstream model id sent to the provider. */
  model: string;
  /** Override adapter default base URL. */
  baseUrl?: string;
  /** Override env var name holding the API key. */
  keyEnv?: string;
}

export interface RateWindow {
  /** Logical name — becomes part of the storage key. */
  name: string;
  limit: number;
  windowSec: number;
}

export interface GatewayProfile {
  name: string;
  /** Exact origins or `*.suffix` wildcards. Requests without an Origin pass (curl, server-to-server). */
  origins: string[];
  cors?: { allowHeaders?: string[]; maxAge?: number };
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

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [k: string]: unknown;
}

/** Read-only view of secrets/env across runtimes (CF bindings, process.env). */
export interface EnvAccess {
  get(name: string): string | undefined;
  /** Raw platform bindings (CF `env`) when present — for AI/ratelimit bindings. */
  cfEnv?: Record<string, unknown>;
}

export interface GatewayContext {
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
export type Step = (ctx: GatewayContext) => Promise<Response | void>;
