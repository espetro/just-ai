// @just-ai/gateway — public API.
// Runtime-agnostic: everything here is h3 + unstorage + ofetch; CF-only
// adapters deactivate automatically off-Cloudflare.

export { createGateway, defaultSteps, type GatewayOptions } from "./createGateway";
export { defineGatewayProfile } from "./profile";
export { modelsList } from "./models";
export { parseModelsJson } from "./config";
export { runPipeline } from "./pipeline";
export { createEnvAccess, getClientIp } from "./env";
export { circuitBreaker } from "./circuit";
export { createRateLimiter, type RateLimiter, type RateLimitResult } from "./ratelimit";
export { memoryLimiter, unstorageLimiter } from "./ratelimit/unstorage";
export { cfBindingLimiter } from "./ratelimit/cfBinding";
export { resolveModel, builtinFactories, OPENAI_COMPAT_PRESETS, type ResolvedModel } from "./providers/sdk";
export { dispatchLane, probeLane, LaneError } from "./providers/dispatch";
export { streamToOpenAiSse, generateToOpenAiJson } from "./providers/emitter";
export * as steps from "./steps";
export {
  gatewayError,
  rateLimited,
  forbidden,
  badRequest,
  allLanesDown,
} from "./errors";
export type {
  GatewayProfile,
  GatewayContext,
  LaneSpec,
  ModelRoute,
  RateWindow,
  ChatRequest,
  ChatMessage,
  Step,
  EnvAccess,
  ModelFactory,
  LaneAttemptInfo,
  RequestDoneInfo,
} from "./types";
