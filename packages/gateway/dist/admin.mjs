import { readBody } from 'h3';
import { c as createEnvAccess, g as getClientIp, a as circuitBreaker, b as builtinFactories, r as resolveModel, p as probeLane } from './shared/gateway.Byslkx36.mjs';
import '@ai-sdk/provider';
import '@ai-sdk/anthropic';
import '@ai-sdk/openai';
import '@ai-sdk/openai-compatible';
import '@ai-sdk/google';
import '@ai-sdk/groq';
import 'workers-ai-provider';

function cfAccess() {
  return ({ event }) => {
    const h = event.node.req.headers;
    return typeof h["cf-access-authenticated-user-email"] === "string" || typeof h["cf-access-jwt-assertion"] === "string";
  };
}
function bearerToken(envName = "JUST_AI_ADMIN_TOKEN") {
  return ({ event, env }) => {
    const token = env.get(envName);
    if (!token) return false;
    const auth = event.node.req.headers.authorization;
    return auth === `Bearer ${token}`;
  };
}
function createAdmin(opts) {
  return async (event) => {
    const profile = typeof opts.profile === "function" ? await opts.profile(event) : opts.profile;
    const storage = typeof opts.storage === "function" ? opts.storage(event) : opts.storage;
    const env = createEnvAccess(event);
    if (!await (opts.authorize?.({ event, env, profile }) ?? Promise.resolve(false))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const ctx = {
      event,
      profile,
      env,
      storage,
      requestId: crypto.randomUUID(),
      clientIp: getClientIp(event),
      providers: opts.providers
    };
    const path = event.path;
    const method = event.method.toUpperCase();
    if (method === "GET" && path.endsWith("/status")) {
      const cb = circuitBreaker(storage);
      const models = {};
      for (const [alias, route] of Object.entries(profile.models)) {
        const lanes = [];
        for (const spec of route.lanes) {
          const laneKey = `${profile.name}:${spec.provider}`;
          const factory = opts.providers?.[spec.provider] ?? builtinFactories[spec.provider];
          const resolved = resolveModel(ctx, spec);
          const keyEnv = spec.keyEnv ?? factory?.keyEnv ?? resolved?.keyEnv;
          const openUntil = await storage.getItem(`cb:${laneKey}:openUntil`) ?? 0;
          const fails = await storage.getItem(`cb:${laneKey}:fails`) ?? 0;
          lanes.push({
            provider: spec.provider,
            model: spec.model,
            keyEnv,
            keyless: factory?.keyless ?? false,
            keyPresent: resolved !== void 0,
            circuit: {
              open: await cb.isOpen(laneKey),
              openUntil: openUntil || void 0,
              fails
            }
          });
        }
        models[alias] = { lanes };
      }
      return Response.json({ profile: profile.name, models });
    }
    if (method === "GET" && path.endsWith("/config")) {
      return Response.json({ profile: profile.name, models: profile.models });
    }
    if (method === "POST" && path.endsWith("/test")) {
      let body = {};
      try {
        body = await readBody(event);
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const results = [];
      for (const [alias, route] of Object.entries(profile.models)) {
        if (body.alias && body.alias !== alias) continue;
        for (const spec of route.lanes) {
          if (body.provider && body.provider !== spec.provider) continue;
          const r = await probeLane(ctx, spec);
          results.push({ alias, provider: spec.provider, model: spec.model, ...r });
        }
      }
      if (!results.length)
        return Response.json(
          { error: "no lanes matched", alias: body.alias, provider: body.provider },
          { status: 404 }
        );
      return Response.json({ results });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}

export { bearerToken, cfAccess, createAdmin };
