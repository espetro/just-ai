import { describe, expect, it, vi, afterEach } from "vitest";
import { originAllowed } from "../src/steps/cors";
import { memoryLimiter } from "../src/ratelimit/unstorage";
import { circuitBreaker } from "../src/circuit";
import { clampStep } from "../src/steps/clamp";
import { proxyStep } from "../src/steps/proxy";
import { rateLimitStep } from "../src/steps/rateLimit";
import { testContext, testProfile } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("originAllowed", () => {
  const allowed = ["https://illo.fyi", "*.illo.fyi"];

  it("allows exact match and wildcard subdomains", () => {
    expect(originAllowed("https://illo.fyi", allowed)).toBe(true);
    expect(originAllowed("https://chat.illo.fyi", allowed)).toBe(true);
  });
  it("rejects lookalike domains", () => {
    expect(originAllowed("https://illo.fyi.evil.com", allowed)).toBe(false);
    expect(originAllowed("https://notillo.fyi", allowed)).toBe(false);
  });
  it("allows missing Origin (non-browser clients)", () => {
    expect(originAllowed(undefined, allowed)).toBe(true);
  });
});

describe("rate limiting", () => {
  it("allows up to the window limit then 429s", async () => {
    const rl = memoryLimiter();
    const w = { name: "burst", limit: 2, windowSec: 60 };
    expect((await rl.limit("ip", w)).success).toBe(true);
    expect((await rl.limit("ip", w)).success).toBe(true);
    const third = await rl.limit("ip", w);
    expect(third.success).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it("rateLimitStep consumes all profile windows per key", async () => {
    const ctx = testContext();
    for (let i = 0; i < 3; i++) {
      expect(await rateLimitStep(ctx)).toBeUndefined();
    }
    const res = await rateLimitStep(ctx);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(429);
    expect(res!.headers.get("retry-after")).toBeTruthy();
  });
});

describe("circuitBreaker", () => {
  it("opens after threshold failures and resets on success", async () => {
    const ctx = testContext();
    const cb = circuitBreaker(ctx.storage, { threshold: 2, cooldownSec: 60 });
    await cb.recordFailure("lane");
    expect(await cb.isOpen("lane")).toBe(false);
    await cb.recordFailure("lane");
    expect(await cb.isOpen("lane")).toBe(true);
    await cb.recordSuccess("lane");
    expect(await cb.isOpen("lane")).toBe(false);
  });
});

describe("clampStep", () => {
  it("clamps max_tokens to the profile ceiling", async () => {
    const ctx = testContext({}, { model: "demo-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 9999 });
    expect(await clampStep(ctx)).toBeUndefined();
    expect(ctx.body!.max_tokens).toBe(100);
  });

  it("rejects unknown model aliases", async () => {
    const ctx = testContext({}, { model: "gpt-4", messages: [{ role: "user", content: "hi" }] });
    const res = await clampStep(ctx);
    expect(res!.status).toBe(400);
  });

  it("rejects oversized prompts before parsing", async () => {
    const profile = testProfile({ clamp: { maxTokens: 10, maxPromptBytes: 10, maxMessages: 5 } });
    const ctx = testContext({ profile }, { model: "demo-chat", messages: [{ role: "user", content: "this is way too long" }] });
    const res = await clampStep(ctx);
    expect(res!.status).toBe(400);
  });
});

describe("proxyStep failover", () => {
  it("fails over to the next lane on upstream 5xx and streams SSE through", async () => {
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {}\n\ndata: [DONE]\n\n"));
        c.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = testContext({}, undefined);
    ctx.body = { model: "demo-chat", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 10 };
    const res = await proxyStep(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("[DONE]");
  });

  it("passes a non-429 4xx straight through instead of failing over", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"bad request"}', { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = testContext();
    ctx.body = { model: "demo-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 10 };
    const res = await proxyStep(ctx);
    expect(res!.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips lanes without keys and 503s when everything fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = testContext();
    ctx.env.get = () => undefined; // no keys at all
    ctx.body = { model: "demo-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 10 };
    const res = await proxyStep(ctx);
    expect(res!.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
