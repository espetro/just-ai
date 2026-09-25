import { allLanesDown } from "../errors";
import { circuitBreaker } from "../circuit";
import { resolveLane } from "../providers";
import type { GatewayContext, Step } from "../types";
import { corsHeaders } from "./cors";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

function passthroughHeaders(upstream: Response, ctx: GatewayContext): Headers {
  const headers = new Headers(corsHeaders(ctx));
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k)) headers.set(k, v);
  }
  headers.set("x-gateway-request-id", ctx.requestId);
  return headers;
}

/** Should we burn the next lane for this upstream status? */
function isFailoverStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Provider failover + SSE passthrough. THE critical constraint: a lane is
 * chosen and committed *before* any body bytes reach the client — once the
 * upstream Response resolves ok, its stream is handed through untouched and
 * retry is impossible.
 */
export const proxyStep: Step = async (ctx) => {
  const route = ctx.profile.models[ctx.body!.model];
  const cb = circuitBreaker(ctx.storage);
  const failures: string[] = [];

  for (const spec of route.lanes) {
    const laneKey = `${ctx.profile.name}:${spec.provider}`;
    const lane = resolveLane(spec);

    if (!lane.available(ctx, spec)) continue;
    if (await cb.isOpen(laneKey)) continue;

    let res: Response;
    try {
      res = await lane.dispatch(ctx, spec, ctx.body!);
    } catch (err) {
      await cb.recordFailure(laneKey);
      failures.push(`${spec.provider}: dispatch ${err instanceof Error ? err.message : "error"}`);
      continue;
    }

    if (res.ok) {
      await cb.recordSuccess(laneKey);
      return new Response(res.body, {
        status: res.status,
        headers: passthroughHeaders(res, ctx),
      });
    }

    // Read a small error body for logging, then decide.
    const detail = await res.text().catch(() => "");
    if (isFailoverStatus(res.status)) {
      await cb.recordFailure(laneKey);
      failures.push(`${spec.provider}: http ${res.status}`);
      continue;
    }
    // 4xx that isn't rate-limit is almost certainly the client's request —
    // surface it verbatim rather than masking it behind a failover.
    return new Response(detail || res.statusText, {
      status: res.status,
      headers: passthroughHeaders(res, ctx),
    });
  }

  console.error("all lanes failed", failures);
  return allLanesDown();
};
