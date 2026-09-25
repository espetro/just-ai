import { rateLimited } from "../errors";
import { createRateLimiter } from "../ratelimit";
import type { Step } from "../types";

/**
 * Per-IP (or per-API-key) fixed-window limiting, checked before the body is
 * even parsed — cheap reject. All profile windows are consumed; the first
 * exceeded window 429s with Retry-After.
 */
export const rateLimitStep: Step = async (ctx) => {
  const rl = createRateLimiter(ctx);
  const key =
    ctx.profile.rateLimit.keyStrategy === "apiKey"
      ? (ctx.event.node.req.headers.authorization?.toString() ?? ctx.clientIp)
      : ctx.clientIp;

  for (const window of ctx.profile.rateLimit.windows) {
    const res = await rl.limit(`${ctx.profile.name}:${key}`, window);
    if (!res.success) return rateLimited(res.retryAfter);
  }
  return undefined;
};
