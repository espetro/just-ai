import type { GatewayContext, RateWindow } from "../types";
import { cfBindingLimiter } from "./cfBinding";
import { memoryLimiter, unstorageLimiter } from "./unstorage";

export interface RateLimitResult {
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
export interface RateLimiter {
  limit(key: string, window: RateWindow): Promise<RateLimitResult>;
}

export function createRateLimiter(ctx: GatewayContext): RateLimiter {
  const pref = ctx.profile.rateLimit.store;
  const native = ctx.env.cfEnv?.RATE_LIMITER as
    | { limit(opts: { key: string }): Promise<{ success: boolean }> }
    | undefined;

  if ((pref === "auto" || pref === "cf-binding") && native) {
    return cfBindingLimiter(native);
  }
  if (pref === "memory") {
    return memoryLimiter();
  }
  if (pref === "cf-binding" && !native) {
    console.warn("rateLimit: cf-binding store selected but RATE_LIMITER binding is absent");
  }
  return unstorageLimiter(ctx.storage);
}
