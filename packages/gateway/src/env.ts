import type { H3Event } from "h3";
import { getRequestIP } from "h3";
import type { EnvAccess } from "./types";

/**
 * Portable env/secret access. Nitro bridges platform env vars (including
 * `wrangler secret` values) into `process.env` *inside the request lifecycle*;
 * we also fall back to the raw CF `env` binding object for binding-only values.
 * NEVER read env vars at module scope — CF only binds them per-request.
 */
export function createEnvAccess(event: H3Event): EnvAccess {
  const cfEnv = (event.context.cloudflare as { env?: Record<string, unknown> })
    ?.env;
  return {
    cfEnv,
    get(name) {
      const v = process.env[name] ?? cfEnv?.[name];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    },
  };
}

/** Client IP: CF header first, then standard fallbacks. Portable. */
export function getClientIp(event: H3Event): string {
  return (
    event.node.req.headers["cf-connecting-ip"]?.toString() ??
    getRequestIP(event, { xForwardedFor: true }) ??
    "0.0.0.0"
  );
}

/**
 * Fire-and-forget a side effect: keep it alive past the response on
 * Cloudflare via `ctx.waitUntil`, run detached elsewhere. Errors are
 * swallowed — circuit writes and observability must never break the
 * streaming path.
 */
export function defer(event: H3Event, work: Promise<unknown> | (() => Promise<unknown>)): void {
  const cfCtx = (event.context.cloudflare as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } })
    ?.ctx;
  const p = typeof work === "function" ? Promise.resolve().then(work) : work;
  cfCtx?.waitUntil?.(p);
  void p.catch(() => {});
}

/** Invoke an observability hook defensively — never throws, never awaits. */
export function emit<A extends unknown[]>(
  hook: ((...args: A) => void) | undefined,
  ...args: A
): void {
  if (!hook) return;
  try {
    hook(...args);
  } catch (err) {
    console.error("gateway hook threw", err);
  }
}
