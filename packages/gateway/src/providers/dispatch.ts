import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import type {
  ChatMessage,
  ChatRequest,
  GatewayContext,
  LaneSpec,
} from "../types";
import { generateToOpenAiJson, streamToOpenAiSse, type TokenUsage } from "./emitter";
import { resolveModel } from "./sdk";

const LANE_TIMEOUT_MS = 30_000;

/** Failure surfaced to the proxy step for failover decisions. */
export class LaneError extends Error {
  /** Upstream HTTP status when known (APICallError), else undefined. */
  status?: number;
  /** Raw upstream error body for pass-through (4xx that isn't failover). */
  body?: string;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.status = status;
    this.cause = cause;
    if (cause instanceof APICallError && typeof cause.responseBody === "string") {
      this.body = cause.responseBody;
    }
  }
}

const statusOf = (err: unknown): number | undefined => {
  if (err instanceof APICallError) return err.statusCode;
  const s = (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { status?: number })?.status;
  return typeof s === "number" ? s : undefined;
};

/** Wrap any dispatch failure into a LaneError carrying its upstream status. */
const toLaneError = (err: unknown): LaneError =>
  err instanceof LaneError
    ? err
    : new LaneError(
        err instanceof Error ? err.message : "dispatch failed",
        statusOf(err),
        err,
      );

/* ---------- OpenAI ChatRequest → LanguageModelV4CallOptions ---------- */

type UserContent = Extract<LanguageModelV4Message, { role: "user" }>["content"];
type AssistantContent = Extract<LanguageModelV4Message, { role: "assistant" }>["content"];
type ToolContent = Extract<LanguageModelV4Message, { role: "tool" }>["content"];

interface OpenAiContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
  [k: string]: unknown;
}

const mediaTypeFromUrl = (url: string): string => {
  const ext = url.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]+$/.test(ext) ? `image/${ext === "jpg" ? "jpeg" : ext}` : "image";
};

function toPrompt(messages: ChatMessage[]): LanguageModelV4Message[] {
  const out: LanguageModelV4Message[] = [];
  for (const m of messages) {
    const role = m.role;
    const content = m.content;
    if (role === "system" || role === "developer") {
      out.push({
        role: "system",
        content: typeof content === "string" ? content : JSON.stringify(content),
      });
      continue;
    }
    if (role === "user") {
      const parts: UserContent =
        typeof content === "string"
          ? [{ type: "text" as const, text: content }]
          : Array.isArray(content)
            ? content
                .map((p: OpenAiContentPart): UserContent[number] | null => {
                  if (p?.type === "text") return { type: "text" as const, text: p.text ?? "" };
                  if (p?.type === "image_url" && p.image_url?.url)
                    return {
                      type: "file" as const,
                      data: { type: "url", url: new URL(p.image_url.url) },
                      mediaType: mediaTypeFromUrl(p.image_url.url),
                    };
                  return null;
                })
                .filter((p): p is UserContent[number] => p !== null)
            : [{ type: "text" as const, text: String(content ?? "") }];
      if (parts.length) out.push({ role: "user", content: parts });
      continue;
    }
    if (role === "assistant") {
      const msg = m as ChatMessage & { tool_calls?: unknown[] };
      const parts: AssistantContent = [];
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((p: OpenAiContentPart) => p?.type === "text")
                .map((p: OpenAiContentPart) => p.text ?? "")
                .join("")
            : "";
      if (text) parts.push({ type: "text" as const, text });
      for (const tc of msg.tool_calls ?? []) {
        const t = tc as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        if (t?.function?.name) {
          let input: unknown = {};
          try {
            input = JSON.parse(t.function.arguments ?? "{}");
          } catch {
            input = {};
          }
          parts.push({
            type: "tool-call" as const,
            toolCallId: t.id ?? crypto.randomUUID(),
            toolName: t.function.name,
            input,
          });
        }
      }
      if (parts.length) out.push({ role: "assistant", content: parts });
      continue;
    }
    if (role === "tool") {
      const msg = m as ChatMessage & { tool_call_id?: string };
      const parts: ToolContent = [
        {
          type: "tool-result" as const,
          toolCallId: msg.tool_call_id ?? "unknown",
          toolName: "tool",
          output: {
            type: "text",
            value: typeof content === "string" ? content : JSON.stringify(content),
          },
        },
      ];
      out.push({ role: "tool", content: parts });
    }
  }
  return out;
}

interface OpenAiToolDef {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
}

function toCallOptions(body: ChatRequest): LanguageModelV4CallOptions {
  const opts: LanguageModelV4CallOptions = { prompt: toPrompt(body.messages) };
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
  const rf = body.response_format as
    | { type?: string; json_schema?: { name?: string; schema?: unknown; description?: string } }
    | undefined;
  if (rf?.type === "json_object") opts.responseFormat = { type: "json" };
  else if (rf?.type === "json_schema")
    opts.responseFormat = {
      type: "json",
      schema: rf.json_schema?.schema as never,
      name: rf.json_schema?.name,
      description: rf.json_schema?.description,
    };

  const tools = body.tools as OpenAiToolDef[] | undefined;
  if (Array.isArray(tools) && tools.length) {
    opts.tools = tools
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        type: "function" as const,
        name: t.function!.name!,
        description: t.function!.description,
        inputSchema: (t.function!.parameters ?? { type: "object", properties: {} }) as never,
        strict: t.function!.strict,
      }));
    const tc = body.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") opts.toolChoice = { type: tc };
    else if (tc && typeof tc === "object") {
      const name = (tc as { function?: { name?: string } }).function?.name;
      if (name) opts.toolChoice = { type: "tool", toolName: name };
    }
  }
  return opts;
}

/* ---------- dispatch ---------- */

export interface LaneDispatch {
  response: Response;
  /** Usage seen at emit time (streams report async — see onDone). */
  usage?: TokenUsage;
}

/**
 * Resolve + dispatch one lane. Throws LaneError on failure BEFORE a response
 * is committed — the proxy step maps `status` to a failover decision.
 * `doGenerate`/`doStream` resolving = upstream answered = commit point.
 */
export async function dispatchLane(
  ctx: GatewayContext,
  spec: LaneSpec,
  body: ChatRequest,
  opts?: {
    model?: LanguageModelV4;
    onDone?: (info: { usage?: TokenUsage; finishReason?: string }) => void;
  },
): Promise<LaneDispatch> {
  const resolved = opts?.model
    ? { model: opts.model }
    : resolveModel(ctx, spec, ctx.providers);
  if (!resolved) throw new LaneError(`lane ${spec.provider}: unavailable`);

  const options = toCallOptions(body);
  options.abortSignal = AbortSignal.timeout(LANE_TIMEOUT_MS);
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    if (body.stream === true) {
      const { stream } = await resolved.model.doStream(options);
      const sse = streamToOpenAiSse(stream, {
        alias: body.model,
        id,
        created,
        sendUsage:
          (body.stream_options as { include_usage?: boolean } | undefined)
            ?.include_usage === true,
        onDone: opts?.onDone,
      });
      return {
        response: new Response(sse, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        }),
      };
    }
    const result = await resolved.model.doGenerate(options);
    const { body: out, usage } = generateToOpenAiJson(result, {
      alias: body.model,
      id,
      created,
    });
    opts?.onDone?.({ usage });
    return {
      usage,
      response: Response.json(out, { status: 200 }),
    };
  } catch (err) {
    throw toLaneError(err);
  }
}

/**
 * Canned probe for a single lane — admin test endpoint and CLI share this.
 * Bypasses failover entirely so the result is this lane's own verdict.
 */
export async function probeLane(
  ctx: GatewayContext,
  spec: LaneSpec,
): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const started = Date.now();
  const resolved = resolveModel(ctx, spec, ctx.providers);
  if (!resolved) return { ok: false, latencyMs: 0, error: "unavailable" };
  try {
    await resolved.model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Reply with: ok" }] }],
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(LANE_TIMEOUT_MS),
    });
    return { ok: true, status: 200, latencyMs: Date.now() - started };
  } catch (err) {
    const e = toLaneError(err);
    return { ok: false, status: e.status, latencyMs: Date.now() - started, error: e.message };
  }
}
