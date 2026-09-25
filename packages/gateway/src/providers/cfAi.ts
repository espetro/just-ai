import type { GatewayContext, LaneSpec } from "../types";
import type { ProviderLane } from "./index";

interface CfAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Cloudflare Workers AI lane — the only adapter that is inherently CF-only
 * (it uses the `ai` binding). available() returns false elsewhere, so the
 * failover chain just skips it on other runtimes.
 */
export const cfAiLane: ProviderLane = {
  available(ctx: GatewayContext) {
    return Boolean(ctx.env.cfEnv?.AI);
  },
  async dispatch(ctx, spec: LaneSpec, body) {
    const ai = ctx.env.cfEnv?.AI as CfAiBinding | undefined;
    if (!ai) throw new Error("cf-ai lane: AI binding absent");

    const messages = (body.messages ?? []).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    const result = (await ai.run(spec.model, {
      messages,
      max_tokens: body.max_tokens,
      stream: body.stream === true,
    })) as ReadableStream | { response?: string };

    if (result instanceof ReadableStream) {
      return new Response(result, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Non-stream Workers AI replies aren't OpenAI-shaped; wrap minimally.
    return Response.json({
      id: `cfai-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: spec.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.response ?? "" },
          finish_reason: "stop",
        },
      ],
    });
  },
};
