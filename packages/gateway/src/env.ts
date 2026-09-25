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
