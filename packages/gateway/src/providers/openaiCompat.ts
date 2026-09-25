import { ofetch } from "ofetch";
import type { ChatRequest, GatewayContext, LaneSpec } from "../types";
import type { ProviderLane } from "./index";

const LANE_TIMEOUT_MS = 30_000;

/**
 * Any OpenAI-compatible `/chat/completions` endpoint. Covers Groq, Z.ai,
 * Google AI Studio (OpenAI shim), OpenRouter — and any future provider that
 * speaks the same wire format — with zero bespoke code.
 */
export function openaiCompatLane(defaults: {
  baseUrl?: string;
  keyEnv?: string;
}): ProviderLane {
  return {
    available(ctx: GatewayContext, spec?: LaneSpec) {
      return Boolean(ctx.env.get(spec?.keyEnv ?? defaults.keyEnv ?? ""));
    },
    async dispatch(ctx, spec, body) {
      const baseUrl = (spec.baseUrl ?? defaults.baseUrl)?.replace(/\/$/, "");
      if (!baseUrl) throw new Error(`lane ${spec.provider}: no baseUrl`);
      const apiKey = ctx.env.get(spec.keyEnv ?? defaults.keyEnv ?? "");
      if (!apiKey) throw new Error(`lane ${spec.provider}: missing API key`);

      return ofetch.raw(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: { ...body, model: spec.model },
        timeout: LANE_TIMEOUT_MS,
        retry: 0, // failover happens at lane level, never mid-lane
        ignoreResponseError: true, // return the raw response, status intact
      });
    },
  };
}
