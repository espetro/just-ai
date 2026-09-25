import { getRequestHeader } from "h3";
import type { GatewayContext, Step } from "../types";

const ALLOWED_METHODS = "POST, OPTIONS";

export function originAllowed(
  origin: string | undefined,
  allowed: string[],
): boolean {
  if (!origin) return true; // non-browser clients send no Origin — gated by ratelimit/botGate instead
  return allowed.some((pattern) => {
    if (pattern === origin) return true;
    if (pattern.startsWith("*.")) {
      try {
        const host = new URL(origin).hostname;
        return host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`);
      } catch {
        return false;
      }
    }
    return false;
  });
}

export function corsHeaders(ctx: GatewayContext): Record<string, string> {
  const origin = getRequestHeader(ctx.event, "origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": (ctx.profile.cors?.allowHeaders ?? [
      "content-type",
      "cf-turnstile-token",
    ]).join(", "),
    "Access-Control-Max-Age": String(ctx.profile.cors?.maxAge ?? 86400),
  };
  if (origin && originAllowed(origin, ctx.profile.origins)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

/** Answers preflights and stamps CORS headers on every downstream response. */
export const corsStep: Step = async (ctx) => {
  const { event } = ctx;
  if (event.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(ctx) });
  }
  return undefined;
};
