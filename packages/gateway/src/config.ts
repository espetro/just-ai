import type { LaneSpec, ModelRoute } from "./types";

/**
 * Validate a JSON model map (public alias → lanes) loaded from config —
 * e.g. a KV key or env var — into the profile's `models` shape.
 * Throws on malformed input so config errors surface loudly at load time.
 */
export function parseModelsJson(input: unknown): Record<string, ModelRoute> {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("models config: expected an object of { alias: { lanes: [...] } }");
  }
  const out: Record<string, ModelRoute> = {};
  for (const [alias, route] of Object.entries(raw as Record<string, unknown>)) {
    const lanes = (route as { lanes?: unknown })?.lanes;
    if (!Array.isArray(lanes) || lanes.length === 0) {
      throw new Error(`models config: "${alias}" needs a non-empty lanes array`);
    }
    out[alias] = {
      lanes: lanes.map((l, i) => {
        const lane = l as Partial<LaneSpec>;
        if (typeof lane.provider !== "string" || !lane.provider) {
          throw new Error(`models config: "${alias}" lane ${i} missing provider`);
        }
        if (typeof lane.model !== "string" || !lane.model) {
          throw new Error(`models config: "${alias}" lane ${i} missing model`);
        }
        const spec: LaneSpec = { provider: lane.provider, model: lane.model };
        if (typeof lane.baseUrl === "string" && lane.baseUrl) spec.baseUrl = lane.baseUrl;
        if (typeof lane.keyEnv === "string" && lane.keyEnv) spec.keyEnv = lane.keyEnv;
        return spec;
      }),
    };
  }
  if (Object.keys(out).length === 0) {
    throw new Error("models config: empty — define at least one public model alias");
  }
  return out;
}
