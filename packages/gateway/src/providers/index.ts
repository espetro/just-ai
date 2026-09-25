import type { ChatRequest, GatewayContext, LaneSpec } from "../types";
import { cfAiLane } from "./cfAi";
import { openaiCompatLane } from "./openaiCompat";

/**
 * A provider adapter turns a LaneSpec into a dispatchable upstream call.
 * Implementations must be constructible without secrets — env access happens
 * inside dispatch()/available() at request time.
 */
export interface ProviderLane {
  /** Can this lane run here? (API key present, CF binding exists, ...) */
  available(ctx: GatewayContext, spec: LaneSpec): boolean;
  /**
   * Fire the upstream request and return the RAW response (possibly an
   * in-flight SSE stream). Callers must treat a resolved ok Response as
   * committed — no retry is possible once streaming starts.
   */
  dispatch(ctx: GatewayContext, spec: LaneSpec, body: ChatRequest): Promise<Response>;
}

const OPENAI_COMPAT_DEFAULTS: Record<
  string,
  { baseUrl: string; keyEnv: string }
> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZAI_API_KEY" },
  google: {
    // Google's OpenAI-compat shim — same wire format, no bespoke adapter.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GOOGLE_AI_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  },
};

/** Registry: lane spec → adapter. Unknown provider keys fall back to openai-compat. */
export function resolveLane(spec: LaneSpec): ProviderLane {
  if (spec.provider === "cf-ai") return cfAiLane;
  const defaults = OPENAI_COMPAT_DEFAULTS[spec.provider];
  return openaiCompatLane(defaults ?? {});
}
