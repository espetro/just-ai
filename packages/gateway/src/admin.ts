import type { H3Event } from "h3";
import { readBody } from "h3";
import type { Storage } from "unstorage";
import { circuitBreaker } from "./circuit";
import { createEnvAccess, getClientIp } from "./env";
import { probeLane } from "./providers/dispatch";
import { builtinFactories, resolveModel } from "./providers/sdk";
import type {
  EnvAccess,
  GatewayContext,
  GatewayProfile,
  ModelFactory,
} from "./types";

/**
 * Read-only admin surface: status, live config, per-lane probe. Writes live
 * in GitOps (config/models.json + CI), so the API only ever reads and
 * probes — there is deliberately no PUT.
 */

export interface AdminAuthInput {
  event: H3Event;
  env: EnvAccess;
  profile: GatewayProfile;
}

/** Return true to allow the admin request; sync or async. */
export type AdminAuthorizer = (input: AdminAuthInput) => boolean | Promise<boolean>;

/**
 * Cloudflare Access — trust the identity headers the CF edge injects after
 * an Access policy passes. REQUIRES the /admin routes to sit behind an
 * Access application (self-hosted or service-token). Without Access in
 * front, these headers are spoofable — pair with JWT verification if the
 * path can ever be reached directly.
 */
export function cfAccess(): AdminAuthorizer {
  return ({ event }) => {
    const h = event.node.req.headers;
    return (
      typeof h["cf-access-authenticated-user-email"] === "string" ||
      typeof h["cf-access-jwt-assertion"] === "string"
    );
  };
}

/** Portable fallback: `Authorization: Bearer <env>` (default JUST_AI_ADMIN_TOKEN). */
export function bearerToken(envName = "JUST_AI_ADMIN_TOKEN"): AdminAuthorizer {
  return ({ event, env }) => {
    const token = env.get(envName);
    if (!token) return false;
    const auth = event.node.req.headers.authorization;
    return auth === `Bearer ${token}`;
  };
}

export interface AdminOptions {
  profile: GatewayProfile | ((event: H3Event) => GatewayProfile | Promise<GatewayProfile>);
  storage: Storage | ((event: H3Event) => Storage);
  /** Default deny when omitted. Compose: `(i) => cfAccess()(i) || bearerToken()(i)`. */
  authorize?: AdminAuthorizer;
  providers?: Record<string, ModelFactory>;
}

interface LaneStatus {
  provider: string;
  model: string;
  keyEnv?: string;
  /** Lane runs without a secret (platform binding). */
  keyless: boolean;
  keyPresent: boolean;
  circuit: { open: boolean; openUntil?: number; fails: number };
}

/**
 * h3 handler for `/admin/api/{status,config,test}` — mount on a wildcard
 * route (e.g. nitro `routes/admin/api/[...].ts`).
 */
export function createAdmin(opts: AdminOptions) {
  return async (event: H3Event): Promise<Response | unknown> => {
    const profile =
      typeof opts.profile === "function" ? await opts.profile(event) : opts.profile;
    const storage =
      typeof opts.storage === "function" ? opts.storage(event) : opts.storage;
    const env = createEnvAccess(event);

    if (!(await (opts.authorize?.({ event, env, profile }) ?? Promise.resolve(false)))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    const ctx: GatewayContext = {
      event,
      profile,
      env,
      storage,
      requestId: crypto.randomUUID(),
      clientIp: getClientIp(event),
      providers: opts.providers,
    };

    const path = event.path;
    const method = event.method.toUpperCase();

    if (method === "GET" && path.endsWith("/status")) {
      const cb = circuitBreaker(storage);
      const models: Record<string, { lanes: LaneStatus[] }> = {};
      for (const [alias, route] of Object.entries(profile.models)) {
        const lanes: LaneStatus[] = [];
        for (const spec of route.lanes) {
          const laneKey = `${profile.name}:${spec.provider}`;
          const factory = opts.providers?.[spec.provider] ?? builtinFactories[spec.provider];
          const resolved = resolveModel(ctx, spec);
          const keyEnv = spec.keyEnv ?? factory?.keyEnv ?? resolved?.keyEnv;
          const openUntil = (await storage.getItem<number>(`cb:${laneKey}:openUntil`)) ?? 0;
          const fails = (await storage.getItem<number>(`cb:${laneKey}:fails`)) ?? 0;
          lanes.push({
            provider: spec.provider,
            model: spec.model,
            keyEnv,
            keyless: factory?.keyless ?? false,
            keyPresent: resolved !== undefined,
            circuit: {
              open: await cb.isOpen(laneKey),
              openUntil: openUntil || undefined,
              fails,
            },
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
      let body: { alias?: string; provider?: string } = {};
      try {
        body = (await readBody(event)) as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const results: Array<Record<string, unknown>> = [];
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
          { status: 404 },
        );
      return Response.json({ results });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  };
}
