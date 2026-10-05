import { getRequestIP } from 'h3';
import { APICallError } from '@ai-sdk/provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createWorkersAI } from 'workers-ai-provider';

function circuitBreaker(storage, opts = {}) {
  const threshold = opts.threshold ?? 3;
  const cooldownSec = opts.cooldownSec ?? 60;
  const failsKey = (lane) => `cb:${lane}:fails`;
  const openKey = (lane) => `cb:${lane}:openUntil`;
  return {
    async isOpen(lane) {
      const until = await storage.getItem(openKey(lane)) ?? 0;
      return until > Math.floor(Date.now() / 1e3);
    },
    async recordSuccess(lane) {
      await storage.removeItem(failsKey(lane));
      await storage.removeItem(openKey(lane));
    },
    async recordFailure(lane) {
      const n = (await storage.getItem(failsKey(lane)) ?? 0) + 1;
      await storage.setItem(failsKey(lane), n, { ttl: cooldownSec * 2 });
      if (n >= threshold) {
        await storage.setItem(
          openKey(lane),
          Math.floor(Date.now() / 1e3) + cooldownSec,
          { ttl: cooldownSec * 2 }
        );
      }
    }
  };
}

function createEnvAccess(event) {
  const cfEnv = event.context.cloudflare?.env;
  return {
    cfEnv,
    get(name) {
      const v = process.env[name] ?? cfEnv?.[name];
      return typeof v === "string" && v.length > 0 ? v : void 0;
    }
  };
}
function getClientIp(event) {
  return event.node.req.headers["cf-connecting-ip"]?.toString() ?? getRequestIP(event, { xForwardedFor: true }) ?? "0.0.0.0";
}
function defer(event, work) {
  const cfCtx = event.context.cloudflare?.ctx;
  const p = typeof work === "function" ? Promise.resolve().then(work) : work;
  cfCtx?.waitUntil?.(p);
  void p.catch(() => {
  });
}
function emit(hook, ...args) {
  if (!hook) return;
  try {
    hook(...args);
  } catch (err) {
    console.error("gateway hook threw", err);
  }
}

const toUsage = (u) => u ? {
  promptTokens: u.inputTokens?.total,
  completionTokens: u.outputTokens?.total
} : void 0;
const openaiUsage = (u) => ({
  prompt_tokens: u.promptTokens ?? 0,
  completion_tokens: u.completionTokens ?? 0,
  total_tokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
});
const mapFinish = (raw) => ({
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  "tool-calls": "tool_calls"
})[raw.unified] ?? "stop";
const chunkLine = (payload) => `data: ${JSON.stringify(payload)}

`;
function streamToOpenAiSse(upstream, opts) {
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  const chunk = (delta, finish = null, usage) => encoder.encode(
    chunkLine({
      id: opts.id,
      object: "chat.completion.chunk",
      created: opts.created,
      model: opts.alias,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...usage !== void 0 ? { usage } : {}
    })
  );
  let roleSent = false;
  let toolIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      for (; ; ) {
        const { done, value: part } = await reader.read();
        if (done) {
          opts.onDone?.({});
          controller.close();
          return;
        }
        if (!roleSent) {
          controller.enqueue(chunk({ role: "assistant" }));
          roleSent = true;
        }
        switch (part.type) {
          case "text-delta":
            controller.enqueue(chunk({ content: part.delta }));
            return;
          case "reasoning-delta":
            controller.enqueue(chunk({ reasoning_content: part.delta }));
            return;
          case "tool-call":
            controller.enqueue(
              chunk({
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: part.toolCallId,
                    type: "function",
                    function: {
                      name: part.toolName,
                      arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {})
                    }
                  }
                ]
              })
            );
            return;
          case "finish": {
            const fr = mapFinish(part.finishReason);
            const usage = opts.sendUsage ? openaiUsage(toUsage(part.usage) ?? {}) : void 0;
            controller.enqueue(chunk({}, fr, usage));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            opts.onDone?.({
              usage: toUsage(part.usage),
              finishReason: fr
            });
            return;
          }
          case "error":
            controller.enqueue(
              encoder.encode(
                chunkLine({
                  error: {
                    message: part.error instanceof Error ? part.error.message : "upstream stream error",
                    type: "upstream_error"
                  }
                })
              )
            );
            opts.onDone?.({});
            return;
          default:
            continue;
        }
      }
    },
    cancel() {
      void reader.cancel();
      opts.onDone?.({});
    }
  });
}
function generateToOpenAiJson(result, opts) {
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let toolIndex = 0;
  for (const part of result.content) {
    if (part.type === "text") content += part.text;
    else if (part.type === "reasoning") reasoning += part.text;
    else if (part.type === "tool-call") {
      toolCalls.push({
        index: toolIndex++,
        id: part.toolCallId,
        type: "function",
        function: {
          name: part.toolName,
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {})
        }
      });
    }
  }
  const usage = toUsage(result.usage);
  return {
    usage,
    body: {
      id: opts.id,
      object: "chat.completion",
      created: opts.created,
      model: opts.alias,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...reasoning ? { reasoning_content: reasoning } : {},
            ...toolCalls.length ? { tool_calls: toolCalls } : {}
          },
          finish_reason: mapFinish(result.finishReason)
        }
      ],
      ...usage ? { usage: openaiUsage(usage) } : {}
    }
  };
}

const openaiCompatFactory = (baseUrl, name) => {
  return (_ctx, spec, apiKey) => {
    const resolved = (spec.baseUrl ?? baseUrl ?? "").replace(/\/$/, "");
    if (!resolved) throw new Error(`lane ${spec.provider}: no baseUrl`);
    return createOpenAICompatible({
      name,
      baseURL: resolved,
      apiKey,
      // Ask upstreams to emit usage in streams — feeds the usage hook and
      // clients that requested stream_options.include_usage.
      includeUsage: true
    }).chatModel(spec.model);
  };
};
const OPENAI_COMPAT_PRESETS = {
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZAI_API_KEY" },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY"
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY"
  }
};
const builtinFactories = {
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    create: (_ctx, spec, apiKey) => createAnthropic({ apiKey, baseURL: spec.baseUrl }).languageModel(spec.model)
  },
  openai: {
    keyEnv: "OPENAI_API_KEY",
    create: (_ctx, spec, apiKey) => createOpenAI({ apiKey, baseURL: spec.baseUrl }).languageModel(spec.model)
  },
  "openai-compat": {
    create: openaiCompatFactory(void 0, "openai-compat")
  },
  google: {
    keyEnv: "GOOGLE_AI_API_KEY",
    create: (_ctx, spec, apiKey) => createGoogleGenerativeAI({ apiKey, baseURL: spec.baseUrl }).languageModel(
      spec.model
    )
  },
  groq: {
    keyEnv: "GROQ_API_KEY",
    create: (_ctx, spec, apiKey) => createGroq({ apiKey, baseURL: spec.baseUrl }).languageModel(spec.model)
  },
  "cf-ai": {
    keyless: true,
    create: (ctx, spec) => {
      const binding = ctx.env.cfEnv?.AI;
      if (!binding) throw new Error("cf-ai lane: AI binding absent");
      return createWorkersAI({ binding }).chat(spec.model);
    }
  },
  zai: {
    keyEnv: "ZAI_API_KEY",
    create: openaiCompatFactory(OPENAI_COMPAT_PRESETS.zai.baseUrl, "zai")
  },
  openrouter: {
    keyEnv: "OPENROUTER_API_KEY",
    create: openaiCompatFactory(OPENAI_COMPAT_PRESETS.openrouter.baseUrl, "openrouter")
  },
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    create: openaiCompatFactory(OPENAI_COMPAT_PRESETS.deepseek.baseUrl, "deepseek")
  }
};
function resolveModel(ctx, spec, custom) {
  let factory = custom?.[spec.provider] ?? builtinFactories[spec.provider];
  if (!factory && spec.baseUrl) {
    factory = {
      create: openaiCompatFactory(void 0, spec.provider)
    };
  }
  if (!factory) return void 0;
  const keyEnv = spec.keyEnv ?? factory.keyEnv;
  const apiKey = keyEnv ? ctx.env.get(keyEnv) : void 0;
  if (!factory.keyless && !apiKey) return void 0;
  try {
    return { model: factory.create(ctx, spec, apiKey), keyEnv };
  } catch {
    return void 0;
  }
}

const LANE_TIMEOUT_MS = 3e4;
class LaneError extends Error {
  /** Upstream HTTP status when known (APICallError), else undefined. */
  status;
  /** Raw upstream error body for pass-through (4xx that isn't failover). */
  body;
  constructor(message, status, cause) {
    super(message);
    this.status = status;
    this.cause = cause;
    if (cause instanceof APICallError && typeof cause.responseBody === "string") {
      this.body = cause.responseBody;
    }
  }
}
const statusOf = (err) => {
  if (err instanceof APICallError) return err.statusCode;
  const s = err?.statusCode ?? err?.status;
  return typeof s === "number" ? s : void 0;
};
const toLaneError = (err) => err instanceof LaneError ? err : new LaneError(
  err instanceof Error ? err.message : "dispatch failed",
  statusOf(err),
  err
);
const mediaTypeFromUrl = (url) => {
  const ext = url.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]+$/.test(ext) ? `image/${ext === "jpg" ? "jpeg" : ext}` : "image";
};
function toPrompt(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role;
    const content = m.content;
    if (role === "system" || role === "developer") {
      out.push({
        role: "system",
        content: typeof content === "string" ? content : JSON.stringify(content)
      });
      continue;
    }
    if (role === "user") {
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map((p) => {
        if (p?.type === "text") return { type: "text", text: p.text ?? "" };
        if (p?.type === "image_url" && p.image_url?.url)
          return {
            type: "file",
            data: { type: "url", url: new URL(p.image_url.url) },
            mediaType: mediaTypeFromUrl(p.image_url.url)
          };
        return null;
      }).filter((p) => p !== null) : [{ type: "text", text: String(content ?? "") }];
      if (parts.length) out.push({ role: "user", content: parts });
      continue;
    }
    if (role === "assistant") {
      const msg = m;
      const parts = [];
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("") : "";
      if (text) parts.push({ type: "text", text });
      for (const tc of msg.tool_calls ?? []) {
        const t = tc;
        if (t?.function?.name) {
          let input = {};
          try {
            input = JSON.parse(t.function.arguments ?? "{}");
          } catch {
            input = {};
          }
          parts.push({
            type: "tool-call",
            toolCallId: t.id ?? crypto.randomUUID(),
            toolName: t.function.name,
            input
          });
        }
      }
      if (parts.length) out.push({ role: "assistant", content: parts });
      continue;
    }
    if (role === "tool") {
      const msg = m;
      const parts = [
        {
          type: "tool-result",
          toolCallId: msg.tool_call_id ?? "unknown",
          toolName: "tool",
          output: {
            type: "text",
            value: typeof content === "string" ? content : JSON.stringify(content)
          }
        }
      ];
      out.push({ role: "tool", content: parts });
    }
  }
  return out;
}
function toCallOptions(body) {
  const opts = { prompt: toPrompt(body.messages) };
  if (body.max_tokens != null) opts.maxOutputTokens = body.max_tokens;
  if (body.temperature != null) opts.temperature = body.temperature;
  if (body.top_p != null) opts.topP = body.top_p;
  if (body.top_k != null) opts.topK = body.top_k;
  if (body.seed != null) opts.seed = body.seed;
  if (body.presence_penalty != null) opts.presencePenalty = body.presence_penalty;
  if (body.frequency_penalty != null) opts.frequencyPenalty = body.frequency_penalty;
  if (body.stop != null) {
    opts.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  const rf = body.response_format;
  if (rf?.type === "json_object") opts.responseFormat = { type: "json" };
  else if (rf?.type === "json_schema")
    opts.responseFormat = {
      type: "json",
      schema: rf.json_schema?.schema,
      name: rf.json_schema?.name,
      description: rf.json_schema?.description
    };
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length) {
    opts.tools = tools.filter((t) => t?.type === "function" && t.function?.name).map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters ?? { type: "object", properties: {} },
      strict: t.function.strict
    }));
    const tc = body.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") opts.toolChoice = { type: tc };
    else if (tc && typeof tc === "object") {
      const name = tc.function?.name;
      if (name) opts.toolChoice = { type: "tool", toolName: name };
    }
  }
  return opts;
}
async function dispatchLane(ctx, spec, body, opts) {
  const resolved = opts?.model ? { model: opts.model } : resolveModel(ctx, spec, ctx.providers);
  if (!resolved) throw new LaneError(`lane ${spec.provider}: unavailable`);
  const options = toCallOptions(body);
  options.abortSignal = AbortSignal.timeout(LANE_TIMEOUT_MS);
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1e3);
  try {
    if (body.stream === true) {
      const { stream } = await resolved.model.doStream(options);
      const sse = streamToOpenAiSse(stream, {
        alias: body.model,
        id,
        created,
        sendUsage: body.stream_options?.include_usage === true,
        onDone: opts?.onDone
      });
      return {
        response: new Response(sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache"
          }
        })
      };
    }
    const result = await resolved.model.doGenerate(options);
    const { body: out, usage } = generateToOpenAiJson(result, {
      alias: body.model,
      id,
      created
    });
    opts?.onDone?.({ usage });
    return {
      usage,
      response: Response.json(out, { status: 200 })
    };
  } catch (err) {
    throw toLaneError(err);
  }
}
async function probeLane(ctx, spec) {
  const started = Date.now();
  const resolved = resolveModel(ctx, spec, ctx.providers);
  if (!resolved) return { ok: false, latencyMs: 0, error: "unavailable" };
  try {
    await resolved.model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Reply with: ok" }] }],
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(LANE_TIMEOUT_MS)
    });
    return { ok: true, status: 200, latencyMs: Date.now() - started };
  } catch (err) {
    const e = toLaneError(err);
    return { ok: false, status: e.status, latencyMs: Date.now() - started, error: e.message };
  }
}

export { LaneError as L, OPENAI_COMPAT_PRESETS as O, circuitBreaker as a, builtinFactories as b, createEnvAccess as c, dispatchLane as d, defer as e, emit as f, getClientIp as g, generateToOpenAiJson as h, probeLane as p, resolveModel as r, streamToOpenAiSse as s };
