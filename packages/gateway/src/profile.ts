import type { GatewayProfile } from "./types";

/**
 * Identity helper for profile files — gives you editor-time type checking and
 * a stable place to hang future profile normalization.
 */
export function defineGatewayProfile(profile: GatewayProfile): GatewayProfile {
  return profile;
}
