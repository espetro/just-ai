import type { H3Event } from "h3";
import type { Storage } from "unstorage";
import { createEnvAccess, getClientIp } from "./env";
import { gatewayError } from "./errors";
import { runPipeline } from "./pipeline";
import { corsHeaders, corsStep } from "./steps/cors";
import { originStep } from "./steps/origin";
import { botGateStep } from "./steps/botGate";
import { rateLimitStep } from "./steps/rateLimit";
import { clampStep } from "./steps/clamp";
import { proxyStep } from "./steps/proxy";
import type { GatewayContext, GatewayProfile, Step } from "./types";

export const defaultSteps: Step[] = [
  corsStep,
  originStep,
  botGateStep,
  rateLimitStep,
  clampStep,
  proxyStep,
];

export interface GatewayOptions {
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
export function createGateway(opts: GatewayOptions) {
  const steps = opts.steps ?? defaultSteps;
  return async function gatewayHandler(event: H3Event): Promise<Response> {
    const profile =
      typeof opts.profile === "function"
        ? await opts.profile(event)
        : opts.profile;
    const storage =
      typeof opts.storage === "function" ? opts.storage(event) : opts.storage;
    const ctx: GatewayContext = {
      event,
      profile,
      env: createEnvAccess(event),
      storage,
      requestId: crypto.randomUUID(),
      clientIp: getClientIp(event),
    };

    if (event.method !== "POST" && event.method !== "OPTIONS") {
      return gatewayError(405, "Method not allowed", "invalid_request_error", {
        allow: "POST, OPTIONS",
      });
    }

    try {
      const res = await runPipeline(ctx, steps);
      // Every response — success or error — gets CORS headers.
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders(ctx))) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      console.error("pipeline error", err);
      return gatewayError(500, "Internal gateway error", "internal");
    }
  };
}
