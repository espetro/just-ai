import { gatewayError } from "./errors";
import type { GatewayContext, Step } from "./types";

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
export async function runPipeline(
  ctx: GatewayContext,
  steps: Step[],
): Promise<Response> {
  for (const step of steps) {
    const res = await step(ctx);
    if (res instanceof Response) return res;
  }
  return gatewayError(500, "Pipeline ended without a response", "internal");
}
