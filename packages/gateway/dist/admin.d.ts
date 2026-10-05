import { H3Event } from 'h3';
import { Storage } from 'unstorage';
import { EnvAccess, GatewayProfile, ModelFactory } from './index.js';
import '@ai-sdk/provider';

/**
 * Read-only admin surface: status, live config, per-lane probe. Writes live
 * in GitOps (config/models.json + CI), so the API only ever reads and
 * probes — there is deliberately no PUT.
 */
interface AdminAuthInput {
    event: H3Event;
    env: EnvAccess;
    profile: GatewayProfile;
}
/** Return true to allow the admin request; sync or async. */
type AdminAuthorizer = (input: AdminAuthInput) => boolean | Promise<boolean>;
/**
 * Cloudflare Access — trust the identity headers the CF edge injects after
 * an Access policy passes. REQUIRES the /admin routes to sit behind an
 * Access application (self-hosted or service-token). Without Access in
 * front, these headers are spoofable — pair with JWT verification if the
 * path can ever be reached directly.
 */
declare function cfAccess(): AdminAuthorizer;
/** Portable fallback: `Authorization: Bearer <env>` (default JUST_AI_ADMIN_TOKEN). */
declare function bearerToken(envName?: string): AdminAuthorizer;
interface AdminOptions {
    profile: GatewayProfile | ((event: H3Event) => GatewayProfile | Promise<GatewayProfile>);
    storage: Storage | ((event: H3Event) => Storage);
    /** Default deny when omitted. Compose: `(i) => cfAccess()(i) || bearerToken()(i)`. */
    authorize?: AdminAuthorizer;
    providers?: Record<string, ModelFactory>;
}
/**
 * h3 handler for `/admin/api/{status,config,test}` — mount on a wildcard
 * route (e.g. nitro `routes/admin/api/[...].ts`).
 */
declare function createAdmin(opts: AdminOptions): (event: H3Event) => Promise<Response | unknown>;

export { bearerToken, cfAccess, createAdmin };
export type { AdminAuthInput, AdminAuthorizer, AdminOptions };
