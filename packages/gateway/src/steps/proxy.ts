import { allLanesDown } from "../errors";
import { circuitBreaker } from "../circuit";
import { defer, emit } from "../env";
import { dispatchLane, LaneError } from "../providers/dispatch";
import { resolveModel } from "../providers/sdk";
import type { GatewayContext, LaneAttemptInfo, Step } from "../types";
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
 * Provider failover + OpenAI-wire passthrough. THE critical constraint: a
 * lane is committed when `doGenerate`/`doStream` resolves — upstream
 * answered — and the emitted stream is handed through untouched; retry is
 * then impossible. dispatchLane throws LaneError before the commit point.
 */
export const proxyStep: Step = async (ctx) => {
  const route = ctx.profile.models[ctx.body!.model];
  const cb = circuitBreaker(ctx.storage);
  const failures: string[] = [];
  const startedAt = Date.now();
  let attempts = 0;

  const emitAttempt = (info: LaneAttemptInfo) => emit(ctx.onLaneAttempt, ctx, info);
  const done = (provider: string | undefined, status: number) => {
    emit(ctx.onRequestDone, ctx, {
      alias: ctx.body!.model,
      provider,
      attempts,
      latencyMs: Date.now() - startedAt,
      status,
    });
  };

  for (const spec of route.lanes) {
    const laneKey = `${ctx.profile.name}:${spec.provider}`;
    const base = { alias: ctx.body!.model, provider: spec.provider, model: spec.model };

    // Resolution doubles as the availability check (key/binding present).
    let lane;
    try {
      lane = resolveModel(ctx, spec, ctx.providers);
    } catch {
      lane = undefined;
    }
    if (!lane) {
      emitAttempt({ ...base, outcome: "skipped_unavailable" });
      continue;
    }
    if (await cb.isOpen(laneKey)) {
      emitAttempt({ ...base, outcome: "skipped_circuit" });
      continue;
    }

    attempts++;
    const t0 = Date.now();
    try {
      const { response } = await dispatchLane(ctx, spec, ctx.body!, {
        model: lane.model,
        onDone: (info) =>
          // Stream usage lands post-commit — reported asynchronously.
          emitAttempt({ ...base, outcome: "ok", status: 200, latencyMs: Date.now() - t0, usage: info.usage }),
      });

      // Fire-and-forget: a storage write must not delay the stream's first byte.
      defer(ctx.event, () => cb.recordSuccess(laneKey));
      const res = new Response(response.body, {
        status: response.status,
        headers: passthroughHeaders(response, ctx),
      });
      done(spec.provider, response.status);
      return res;
    } catch (err) {
      const le = err instanceof LaneError ? err : new LaneError("dispatch failed");
      const status = le.status;
      const failover = status === undefined || isFailoverStatus(status);
      if (failover) defer(ctx.event, () => cb.recordFailure(laneKey));
      emitAttempt({
        ...base,
        outcome: failover ? "failed" : "client_error",
        status,
        latencyMs: Date.now() - t0,
      });
      if (!failover) {
        // Non-429 4xx is almost certainly the client's request — surface it
        // verbatim rather than masking it behind a failover.
        done(spec.provider, status!);
        return new Response(le.body ?? le.message ?? "Upstream error", {
          status: status!,
          headers: corsHeaders(ctx) as unknown as Headers,
        });
      }
      failures.push(`${spec.provider}: ${le.message}`);
    }
  }

  console.error("all lanes failed", failures);
  done(undefined, 503);
  return allLanesDown();
};
