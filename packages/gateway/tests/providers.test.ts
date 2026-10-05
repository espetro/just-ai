import { describe, expect, it, vi, afterEach } from "vitest";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { proxyStep } from "../src/steps/proxy";
import { resolveModel } from "../src/providers/sdk";
import { probeLane, dispatchLane } from "../src/providers/dispatch";
import { streamToOpenAiSse, generateToOpenAiJson } from "../src/providers/emitter";
import { testContext, testProfile } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const streamOf = (parts: LanguageModelV4StreamPart[]) =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

const parseSse = async (body: ReadableStream<Uint8Array>) => {
  const text = await new Response(body).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((l) => l.replace(/^data: /, ""));
};

describe("streamToOpenAiSse", () => {
  it("emits OpenAI chat.completion.chunk frames + [DONE]", async () => {
    const sse = streamToOpenAiSse(
      streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hello" },
        { type: "text-delta", id: "t1", delta: " world" },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        },
      ]),
      { alias: "demo-chat", id: "cmpl-1", created: 1, sendUsage: true },
    );
    const frames = await parseSse(sse);
    expect(frames.at(-1)).toBe("[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(chunks[0].model).toBe("demo-chat");
    const deltas = chunks.map((c) => c.choices[0].delta?.content).filter(Boolean);
    expect(deltas.join("")).toBe("hello world");
    const finish = chunks.find((c) => c.choices[0].finish_reason);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage.prompt_tokens).toBe(3);
    expect(finish.usage.completion_tokens).toBe(5);
  });

  it("maps reasoning and tool calls to OpenAI deltas", async () => {
    const sse = streamToOpenAiSse(
      streamOf([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-delta", id: "r1", delta: "thinking" },
        { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: JSON.stringify({ city: "SF" }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        } },
      ]),
      { alias: "a", id: "x", created: 1, sendUsage: false },
    );
    const frames = (await parseSse(sse)).slice(0, -1).map((f) => JSON.parse(f));
    expect(frames[0].choices[0].delta.role).toBe("assistant");
    expect(frames[1].choices[0].delta.reasoning_content).toBe("thinking");
    const tc = frames[2].choices[0].delta.tool_calls[0];
    expect(tc.id).toBe("call_1");
    expect(tc.function.name).toBe("get_weather");
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: "SF" });
    expect(frames.at(-1)!.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("generateToOpenAiJson", () => {
  it("emits an OpenAI chat.completion body + usage", () => {
    const { body, usage } = generateToOpenAiJson(
      {
        content: [
          { type: "text", text: "hi" },
          { type: "reasoning", text: "because" },
          { type: "tool-call", toolCallId: "c1", toolName: "f", input: JSON.stringify({ a: 1 }) },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        warnings: [],
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4, text: 4, reasoning: undefined },
        },
      },
      { alias: "demo-chat", id: "cmpl-2", created: 1 },
    );
    const out = body as {
      object: string;
      model: string;
      choices: Array<{ message: Record<string, unknown>; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("demo-chat");
    const msg = out.choices[0].message;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("hi");
    expect(msg.reasoning_content).toBe("because");
    expect(msg.tool_calls).toHaveLength(1);
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 4 });
  });
});

describe("resolveModel + custom providers", () => {
  it("resolves built-in provider names and falls back to openai-compat with baseUrl", () => {
    const ctx = testContext();
    const anthropic = resolveModel(ctx, { provider: "anthropic", model: "claude-x", keyEnv: "KEY_A" });
    expect(anthropic?.model.modelId).toBe("claude-x");
    // unknown provider + baseUrl → openai-compat
    const custom = resolveModel(ctx, { provider: "weird", baseUrl: "https://w.example/v1", keyEnv: "KEY_A", model: "m" });
    expect(custom?.model).toBeDefined();
    // missing key → undefined (lane skipped)
    ctx.env.get = () => undefined;
    expect(resolveModel(ctx, { provider: "anthropic", model: "x" })).toBeUndefined();
  });

  it("deployment factories shadow built-ins", () => {
    const ctx = testContext();
    const stub: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: "mine",
      modelId: "m1",
      supportedUrls: {},
      doGenerate: async () => ({ content: [], finishReason: { unified: "stop", raw: "stop" }, usage: undefined as never, warnings: [] }),
      doStream: async () => ({ stream: streamOf([]) }),
    };
    const providers = {
      anthropic: { keyless: true, create: () => stub },
    };
    const r = resolveModel(ctx, { provider: "anthropic", model: "m1" }, providers);
    expect(r?.model.provider).toBe("mine");
  });
});

describe("proxyStep hooks + dispatch", () => {
  it("emits onLaneAttempt skipped_unavailable / ok and onRequestDone", async () => {
    const attempts: Array<{ outcome: string; provider: string }> = [];
    const done: Array<{ provider?: string; status: number; attempts: number }> = [];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "c", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = testContext({
      onLaneAttempt: (_c, info) => { attempts.push(info); },
      onRequestDone: (_c, info) => { done.push(info); },
      profile: testProfile({
        models: {
          "demo-chat": { lanes: [
            { provider: "no-key", baseUrl: "https://x/v1", keyEnv: "MISSING", model: "m" },
            { provider: "ok", baseUrl: "https://y/v1", keyEnv: "KEY_A", model: "m" },
          ] },
        },
      }),
    });
    ctx.body = { model: "demo-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
    const res = await proxyStep(ctx);
    expect(res!.status).toBe(200);
    expect(attempts[0].outcome).toBe("skipped_unavailable");
    expect(attempts[1].outcome).toBe("ok");
    expect(done[0].provider).toBe("ok");
    expect(done[0].attempts).toBe(1);
  });
});

describe("probeLane", () => {
  it("probes a lane without touching failover", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "c", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = testContext();
    const r = await probeLane(ctx, { provider: "x", baseUrl: "https://x/v1", keyEnv: "KEY_A", model: "m" });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("https://x/v1/chat/completions");
  });

  it("reports upstream status on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const ctx = testContext();
    const r = await probeLane(ctx, { provider: "x", baseUrl: "https://x/v1", keyEnv: "KEY_A", model: "m" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});
