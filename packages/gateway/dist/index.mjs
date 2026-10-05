import { a as circuitBreaker, r as resolveModel, d as dispatchLane, e as defer, L as LaneError, f as emit, g as getClientIp, c as createEnvAccess } from './shared/gateway.Byslkx36.mjs';
export { O as OPENAI_COMPAT_PRESETS, b as builtinFactories, h as generateToOpenAiJson, p as probeLane, s as streamToOpenAiSse } from './shared/gateway.Byslkx36.mjs';
import { getRequestHeader, readRawBody } from 'h3';
import { ofetch } from 'ofetch';
import { createStorage } from 'unstorage';
import memoryDriver from 'unstorage/drivers/memory';
import '@ai-sdk/provider';
import '@ai-sdk/anthropic';
import '@ai-sdk/openai';
import '@ai-sdk/openai-compatible';
import '@ai-sdk/google';
import '@ai-sdk/groq';
import 'workers-ai-provider';

function gatewayError(status, message, type, headers = {}) {
  return Response.json(
    { error: { message, type, code: status } },
    { status, headers }
  );
}
function rateLimited(retryAfter) {
  return gatewayError(429, "Rate limit exceeded", "rate_limit_exceeded", {
    "Retry-After": String(retryAfter)
  });
}
function forbidden(message = "Forbidden") {
  return gatewayError(403, message, "forbidden");
}
function badRequest(message) {
  return gatewayError(400, message, "invalid_request_error");
}
function allLanesDown() {
  return gatewayError(
    503,
    "All upstream providers are unavailable",
    "upstream_unavailable",
    { "Retry-After": "60" }
  );
}

async function runPipeline(ctx, steps) {
  for (const step of steps) {
    const res = await step(ctx);
    if (res instanceof Response) return res;
  }
  return gatewayError(500, "Pipeline ended without a response", "internal");
}

const ALLOWED_METHODS = "POST, OPTIONS";
function originAllowed(origin, allowed) {
  if (!origin) return true;
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
function corsHeaders(ctx) {
  const origin = getRequestHeader(ctx.event, "origin");
  const headers = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": (ctx.profile.cors?.allowHeaders ?? [
      "content-type",
      "cf-turnstile-token"
    ]).join(", "),
    "Access-Control-Max-Age": String(ctx.profile.cors?.maxAge ?? 86400)
  };
  if (origin && originAllowed(origin, ctx.profile.origins)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}
const corsStep = async (ctx) => {
  const { event } = ctx;
  if (event.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(ctx) });
  }
  return void 0;
};

const originStep = async (ctx) => {
  const origin = getRequestHeader(ctx.event, "origin");
  if (!originAllowed(origin, ctx.profile.origins)) {
    return forbidden("Origin not allowed");
  }
  return void 0;
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const botGateStep = async (ctx) => {
  const gate = ctx.profile.botGate;
  if (gate.type === "none") return void 0;
  const header = gate.header ?? "cf-turnstile-token";
  const token = ctx.event.node.req.headers[header]?.toString();
  if (!token) return forbidden("Missing bot-check token");
  const secret = ctx.env.get(gate.secretEnv ?? "TURNSTILE_SECRET_KEY");
  if (!secret) {
    console.error(`botGate: missing secret ${gate.secretEnv ?? "TURNSTILE_SECRET_KEY"}`);
    return forbidden("Bot check misconfigured");
  }
  const res = await ofetch(SITEVERIFY_URL, {
    method: "POST",
    body: { secret, response: token, remoteip: ctx.clientIp },
    retry: 1,
    timeout: 5e3
  }).catch(() => null);
  if (!res?.success) return forbidden("Bot check failed");
  if (gate.allowedHostnames?.length && (!res.hostname || !gate.allowedHostnames.includes(res.hostname))) {
    return forbidden("Bot check hostname mismatch");
  }
  return void 0;
};

function cfBindingLimiter(binding) {
  return {
    async limit(key, _window) {
      const { success } = await binding.limit({ key });
      return { success, retryAfter: 60 };
    }
  };
}

function unstorageLimiter(storage) {
  return {
    async limit(key, window) {
      const now = Math.floor(Date.now() / 1e3);
      const bucket = Math.floor(now / window.windowSec);
      const retryAfter = (bucket + 1) * window.windowSec - now;
      const k = `rl:${window.name}:${key}:${bucket}`;
      const n = (await storage.getItem(k) ?? 0) + 1;
      await storage.setItem(k, n, { ttl: window.windowSec * 2 });
      return { success: n <= window.limit, retryAfter };
    }
  };
}
let sharedMemoryStorage;
function memoryLimiter() {
  sharedMemoryStorage ??= createStorage({ driver: memoryDriver() });
  return unstorageLimiter(sharedMemoryStorage);
}

function createRateLimiter(ctx) {
  const pref = ctx.profile.rateLimit.store;
  const native = ctx.env.cfEnv?.RATE_LIMITER;
  if ((pref === "auto" || pref === "cf-binding") && native) {
    return cfBindingLimiter(native);
  }
  if (pref === "memory") {
    return memoryLimiter();
  }
  if (pref === "cf-binding" && !native) {
    console.warn("rateLimit: cf-binding store selected but RATE_LIMITER binding is absent");
  }
  return unstorageLimiter(ctx.storage);
}

const rateLimitStep = async (ctx) => {
  const rl = createRateLimiter(ctx);
  const key = ctx.profile.rateLimit.keyStrategy === "apiKey" ? ctx.event.node.req.headers.authorization?.toString() ?? ctx.clientIp : ctx.clientIp;
  for (const window of ctx.profile.rateLimit.windows) {
    const res = await rl.limit(`${ctx.profile.name}:${key}`, window);
    if (!res.success) return rateLimited(res.retryAfter);
  }
  return void 0;
};

const encoder = new TextEncoder();
const clampStep = async (ctx) => {
  const raw = await readRawBody(ctx.event, "utf8");
  if (!raw) return badRequest("Empty body");
  if (encoder.encode(raw).byteLength > ctx.profile.clamp.maxPromptBytes) {
    return badRequest("Prompt exceeds size limit");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("Invalid JSON body");
  }
  if (!body.model || typeof body.model !== "string") {
    return badRequest("Missing `model`");
  }
  if (!ctx.profile.models[body.model]) {
    return gatewayError(400, `Unknown model "${body.model}"`, "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequest("`messages` must be a non-empty array");
  }
  if (body.messages.length > ctx.profile.clamp.maxMessages) {
    return badRequest("Too many messages");
  }
  if (body.stream && ctx.profile.clamp.stream === false) {
    return badRequest("Streaming not enabled for this model");
  }
  ctx.body = {
    ...body,
    max_tokens: Math.min(
      body.max_tokens ?? ctx.profile.clamp.maxTokens,
      ctx.profile.clamp.maxTokens
    )
  };
  return void 0;
};

const HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length"
]);
function passthroughHeaders(upstream, ctx) {
  const headers = new Headers(corsHeaders(ctx));
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k)) headers.set(k, v);
  }
  headers.set("x-gateway-request-id", ctx.requestId);
  return headers;
}
function isFailoverStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
const proxyStep = async (ctx) => {
  const route = ctx.profile.models[ctx.body.model];
  const cb = circuitBreaker(ctx.storage);
  const failures = [];
  const startedAt = Date.now();
  let attempts = 0;
  const emitAttempt = (info) => emit(ctx.onLaneAttempt, ctx, info);
  const done = (provider, status) => {
    emit(ctx.onRequestDone, ctx, {
      alias: ctx.body.model,
      provider,
      attempts,
      latencyMs: Date.now() - startedAt,
      status
    });
  };
  for (const spec of route.lanes) {
    const laneKey = `${ctx.profile.name}:${spec.provider}`;
    const base = { alias: ctx.body.model, provider: spec.provider, model: spec.model };
    let lane;
    try {
      lane = resolveModel(ctx, spec, ctx.providers);
    } catch {
      lane = void 0;
    }
    if (!lane) {
      emitAttempt({ ...base, outcome: "skipped_unavailable" });
      continue;
    }
    if (await cb.isOpen(laneKey)) {
      emitAttempt({ ...base, outcome: "skipped_circuit" });
      continue;
    }
    attempts++;
    const t0 = Date.now();
    try {
      const { response } = await dispatchLane(ctx, spec, ctx.body, {
        model: lane.model,
        onDone: (info) => (
          // Stream usage lands post-commit — reported asynchronously.
          emitAttempt({ ...base, outcome: "ok", status: 200, latencyMs: Date.now() - t0, usage: info.usage })
        )
      });
      defer(ctx.event, () => cb.recordSuccess(laneKey));
      const res = new Response(response.body, {
        status: response.status,
        headers: passthroughHeaders(response, ctx)
      });
      done(spec.provider, response.status);
      return res;
    } catch (err) {
      const le = err instanceof LaneError ? err : new LaneError("dispatch failed");
      const status = le.status;
      const failover = status === void 0 || isFailoverStatus(status);
      if (failover) defer(ctx.event, () => cb.recordFailure(laneKey));
      emitAttempt({
        ...base,
        outcome: failover ? "failed" : "client_error",
        status,
        latencyMs: Date.now() - t0
      });
      if (!failover) {
        done(spec.provider, status);
        return new Response(le.body ?? le.message ?? "Upstream error", {
          status,
          headers: corsHeaders(ctx)
        });
      }
      failures.push(`${spec.provider}: ${le.message}`);
    }
  }
  console.error("all lanes failed", failures);
  done(void 0, 503);
  return allLanesDown();
};

const defaultSteps = [
  corsStep,
  originStep,
  botGateStep,
  rateLimitStep,
  clampStep,
  proxyStep
];
function createGateway(opts) {
  const steps = opts.steps ?? defaultSteps;
  return async function gatewayHandler(event) {
    if (event.method !== "POST" && event.method !== "OPTIONS") {
      return gatewayError(405, "Method not allowed", "invalid_request_error", {
        allow: "POST, OPTIONS"
      });
    }
    try {
      const profile = typeof opts.profile === "function" ? await opts.profile(event) : opts.profile;
      const storage = typeof opts.storage === "function" ? opts.storage(event) : opts.storage;
      const ctx = {
        event,
        profile,
        env: createEnvAccess(event),
        storage,
        requestId: crypto.randomUUID(),
        clientIp: getClientIp(event),
        providers: opts.providers,
        onLaneAttempt: opts.onLaneAttempt,
        onRequestDone: opts.onRequestDone
      };
      const res = await runPipeline(ctx, steps);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders(ctx))) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      console.error("gateway error", err);
      return gatewayError(500, "Internal gateway error", "internal");
    }
  };
}

function defineGatewayProfile(profile) {
  return profile;
}

function modelsList(profile) {
  return {
    object: "list",
    data: Object.keys(profile.models).map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "gateway"
    }))
  };
}

function parseModelsJson(input) {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("models config: expected an object of { alias: { lanes: [...] } }");
  }
  const out = {};
  for (const [alias, route] of Object.entries(raw)) {
    const lanes = route?.lanes;
    if (!Array.isArray(lanes) || lanes.length === 0) {
      throw new Error(`models config: "${alias}" needs a non-empty lanes array`);
    }
    out[alias] = {
      lanes: lanes.map((l, i) => {
        const lane = l;
        if (typeof lane.provider !== "string" || !lane.provider) {
          throw new Error(`models config: "${alias}" lane ${i} missing provider`);
        }
        if (typeof lane.model !== "string" || !lane.model) {
          throw new Error(`models config: "${alias}" lane ${i} missing model`);
        }
        const spec = { provider: lane.provider, model: lane.model };
        if (typeof lane.baseUrl === "string" && lane.baseUrl) spec.baseUrl = lane.baseUrl;
        if (typeof lane.keyEnv === "string" && lane.keyEnv) spec.keyEnv = lane.keyEnv;
        return spec;
      })
    };
  }
  if (Object.keys(out).length === 0) {
    throw new Error("models config: empty \u2014 define at least one public model alias");
  }
  return out;
}

const index = {
  __proto__: null,
  botGateStep: botGateStep,
  clampStep: clampStep,
  corsHeaders: corsHeaders,
  corsStep: corsStep,
  originAllowed: originAllowed,
  originStep: originStep,
  proxyStep: proxyStep,
  rateLimitStep: rateLimitStep
};

export { LaneError, allLanesDown, badRequest, cfBindingLimiter, circuitBreaker, createEnvAccess, createGateway, createRateLimiter, defaultSteps, defineGatewayProfile, dispatchLane, forbidden, gatewayError, getClientIp, memoryLimiter, modelsList, parseModelsJson, rateLimited, resolveModel, runPipeline, index as steps, unstorageLimiter };
