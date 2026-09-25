import { ofetch } from "ofetch";
import { forbidden } from "../errors";
import type { Step } from "../types";

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile verification — a plain fetch, so this step is already
 * runtime-agnostic. Tokens are single-use and hostname-bound (checked against
 * profile.botGate.allowedHostnames).
 */
export const botGateStep: Step = async (ctx) => {
  const gate = ctx.profile.botGate;
  if (gate.type === "none") return undefined;

  const header = gate.header ?? "cf-turnstile-token";
  const token = ctx.event.node.req.headers[header]?.toString();
  if (!token) return forbidden("Missing bot-check token");

  const secret = ctx.env.get(gate.secretEnv ?? "TURNSTILE_SECRET_KEY");
  if (!secret) {
    console.error(`botGate: missing secret ${gate.secretEnv ?? "TURNSTILE_SECRET_KEY"}`);
    return forbidden("Bot check misconfigured");
  }

  const res = await ofetch<SiteverifyResponse>(SITEVERIFY_URL, {
    method: "POST",
    body: { secret, response: token, remoteip: ctx.clientIp },
    retry: 1,
    timeout: 5_000,
  }).catch(() => null);

  if (!res?.success) return forbidden("Bot check failed");
  if (
    gate.allowedHostnames?.length &&
    (!res.hostname || !gate.allowedHostnames.includes(res.hostname))
  ) {
    return forbidden("Bot check hostname mismatch");
  }
  return undefined;
};
