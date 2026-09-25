import { createGateway } from "@just-ai/gateway";
import { exampleProfile } from "../../../profiles/example";

/**
 * POST /v1/chat/completions (+ OPTIONS). One line per project: pick a profile
 * (or resolve one per-request) and a storage mount — the pipeline does the
 * rest: cors → origin → botGate → rateLimit → clamp → failover → SSE.
 */
export default defineEventHandler(
  createGateway({
    profile: exampleProfile,
    storage: () => useStorage("ratelimit"),
  }),
);
