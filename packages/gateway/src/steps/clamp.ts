import { readRawBody } from "h3";
import { badRequest, gatewayError } from "../errors";
import type { ChatRequest, Step } from "../types";

const encoder = new TextEncoder();

/**
 * Parse + clamp the request body before any upstream call:
 *  - raw size cap (before JSON.parse, so huge bodies reject cheaply)
 *  - model must be a profile-declared public alias (upstream ids never leak in)
 *  - max_tokens clamped to the profile ceiling, messages array capped
 */
export const clampStep: Step = async (ctx) => {
  const raw = await readRawBody(ctx.event, "utf8");
  if (!raw) return badRequest("Empty body");
  if (encoder.encode(raw).byteLength > ctx.profile.clamp.maxPromptBytes) {
    return badRequest("Prompt exceeds size limit");
  }

  let body: ChatRequest;
  try {
    body = JSON.parse(raw) as ChatRequest;
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
      ctx.profile.clamp.maxTokens,
    ),
  };
  return undefined;
};
