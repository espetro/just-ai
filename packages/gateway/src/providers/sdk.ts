import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createWorkersAI } from "workers-ai-provider";
import type { GatewayContext, LaneSpec, ModelFactory } from "../types";

export type { ModelFactory };

/** Any OpenAI-compatible `/chat/completions` endpoint. */
const openaiCompatFactory = (
  baseUrl: string | undefined,
  name: string,
): ModelFactory["create"] => {
  return (_ctx, spec, apiKey) => {
    const resolved = (spec.baseUrl ?? baseUrl ?? "").replace(/\/$/, "");
    if (!resolved) throw new Error(`lane ${spec.provider}: no baseUrl`);
    return createOpenAICompatible({
      name,
      baseURL: resolved,
      apiKey,
      // Ask upstreams to emit usage in streams — feeds the usage hook and
      // clients that requested stream_options.include_usage.
      includeUsage: true,
    }).chatModel(spec.model);
  };
};

export const OPENAI_COMPAT_PRESETS: Record<string, { baseUrl: string; keyEnv: string }> = {
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZAI_API_KEY" },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
  },
};

/** Built-in factories. Unknown provider + explicit baseUrl → openai-compat. */
export const builtinFactories: Record<string, ModelFactory> = {
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    create: (_ctx, spec, apiKey) =>
      createAnthropic({ apiKey, baseURL: spec.baseUrl }).languageModel(spec.model),
  },
  openai: {
    keyEnv: "OPENAI_API_KEY",
    create: (_ctx, spec, apiKey) =>
      createOpenAI({ apiKey, baseURL: spec.baseUrl }).languageModel(spec.model),
  },
  "openai-compat": {
    create: openaiCompatFactory(undefined, "openai-compat"),
  },
  google: {
    keyEnv: "GOOGLE_AI_API_KEY",
    create: (_ctx, spec, apiKey) =>
      createGoogleGenerativeAI({ apiKey, baseURL: spec.baseUrl }).languageModel(
        spec.model,
      ),
  },
  groq: {
    keyEnv: "GROQ_API_KEY",
    create: (_ctx, spec, apiKey) =>
      createGroq({ apiKey, baseURL: spec.baseUrl }).languageModel(spec.model),
  },
  "cf-ai": {
    keyless: true,
    create: (ctx, spec) => {
      const binding = ctx.env.cfEnv?.AI as Parameters<typeof createWorkersAI>[0]["binding"];
      if (!binding) throw new Error("cf-ai lane: AI binding absent");
      return createWorkersAI({ binding }).chat(spec.model);
    },
  },
  zai: {
    keyEnv: "ZAI_API_KEY",
    create: openaiCompatFactory(OPENAI_COMPAT_PRESETS.zai.baseUrl, "zai"),
  },
  openrouter: {
    keyEnv: "OPENROUTER_API_KEY",
    create: openaiCompatFactory(OPENAI_COMPAT_PRESETS.openrouter.baseUrl, "openrouter"),
  },
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    create: openaiCompatFactory(OPENAI_COMPAT_PRESETS.deepseek.baseUrl, "deepseek"),
  },
};

export interface ResolvedModel {
  model: LanguageModelV4;
  /** Env var name the key came from (for diagnostics — never the value). */
  keyEnv?: string;
}

/**
 * Resolve a lane to a LanguageModel, or undefined when it can't run here
 * (missing key, missing binding) — the failover chain just skips it.
 * `custom` factories (createGateway providers option) shadow built-ins.
 */
export function resolveModel(
  ctx: GatewayContext,
  spec: LaneSpec,
  custom?: Record<string, ModelFactory>,
): ResolvedModel | undefined {
  let factory = custom?.[spec.provider] ?? builtinFactories[spec.provider];
  if (!factory && spec.baseUrl) {
    // Any provider name with an explicit baseUrl → openai-compat endpoint.
    factory = {
      create: openaiCompatFactory(undefined, spec.provider),
    };
  }
  if (!factory) return undefined;

  const keyEnv = spec.keyEnv ?? factory.keyEnv;
  const apiKey = keyEnv ? ctx.env.get(keyEnv) : undefined;
  if (!factory.keyless && !apiKey) return undefined;

  try {
    return { model: factory.create(ctx, spec, apiKey), keyEnv };
  } catch {
    return undefined;
  }
}
