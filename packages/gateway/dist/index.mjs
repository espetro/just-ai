import { getRequestIP, getRequestHeader, readRawBody } from 'h3';
import { ofetch } from 'ofetch';
import { createStorage } from 'unstorage';
import memoryDriver from 'unstorage/drivers/memory';

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

const cfAiLane = {
  available(ctx) {
    return Boolean(ctx.env.cfEnv?.AI);
  },
  async dispatch(ctx, spec, body) {
    const ai = ctx.env.cfEnv?.AI;
    if (!ai) throw new Error("cf-ai lane: AI binding absent");
    const messages = (body.messages ?? []).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }));
    const result = await ai.run(spec.model, {
      messages,
      max_tokens: body.max_tokens,
      stream: body.stream === true
    });
    if (result instanceof ReadableStream) {
      return new Response(result, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return Response.json({
      id: `cfai-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model: spec.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.response ?? "" },
          finish_reason: "stop"
        }
      ]
    });
  }
};

const LANE_TIMEOUT_MS = 3e4;
function openaiCompatLane(defaults) {
  return {
    available(ctx, spec) {
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
          "content-type": "application/json"
        },
        body: { ...body, model: spec.model },
        timeout: LANE_TIMEOUT_MS,
        retry: 0,
        // failover happens at lane level, never mid-lane
        ignoreResponseError: true
        // return the raw response, status intact
      });
    }
  };
}

const OPENAI_COMPAT_DEFAULTS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", keyEnv: "ZAI_API_KEY" },
  google: {
    // Google's OpenAI-compat shim — same wire format, no bespoke adapter.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GOOGLE_AI_API_KEY"
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY"
  }
};
function resolveLane(spec) {
  if (spec.provider === "cf-ai") return cfAiLane;
  const defaults = OPENAI_COMPAT_DEFAULTS[spec.provider];
  return openaiCompatLane(defaults ?? {});
}

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
  for (const spec of route.lanes) {
    const laneKey = `${ctx.profile.name}:${spec.provider}`;
    const lane = resolveLane(spec);
    if (!lane.available(ctx, spec)) continue;
    if (await cb.isOpen(laneKey)) continue;
    let res;
    try {
      res = await lane.dispatch(ctx, spec, ctx.body);
    } catch (err) {
      await cb.recordFailure(laneKey);
      failures.push(`${spec.provider}: dispatch ${err instanceof Error ? err.message : "error"}`);
      continue;
    }
    if (res.ok) {
      await cb.recordSuccess(laneKey);
      return new Response(res.body, {
        status: res.status,
        headers: passthroughHeaders(res, ctx)
      });
    }
    const detail = await res.text().catch(() => "");
    if (isFailoverStatus(res.status)) {
      await cb.recordFailure(laneKey);
      failures.push(`${spec.provider}: http ${res.status}`);
      continue;
    }
    return new Response(detail || res.statusText, {
      status: res.status,
      headers: passthroughHeaders(res, ctx)
    });
  }
  console.error("all lanes failed", failures);
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
        clientIp: getClientIp(event)
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

export { allLanesDown, badRequest, cfAiLane, cfBindingLimiter, circuitBreaker, createEnvAccess, createGateway, createRateLimiter, defaultSteps, defineGatewayProfile, forbidden, gatewayError, getClientIp, memoryLimiter, modelsList, openaiCompatLane, parseModelsJson, rateLimited, resolveLane, runPipeline, index as steps, unstorageLimiter };
