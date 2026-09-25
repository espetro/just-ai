import type { GatewayProfile } from "./types";

/** OpenAI-shaped /v1/models payload — public aliases only, lanes never exposed. */
export function modelsList(profile: GatewayProfile) {
  return {
    object: "list" as const,
    data: Object.keys(profile.models).map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: "gateway",
    })),
  };
}
