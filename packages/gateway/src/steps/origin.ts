import { getRequestHeader } from "h3";
import { forbidden } from "../errors";
import type { Step } from "../types";
import { originAllowed } from "./cors";

/**
 * First-party gate: browsers always send Origin on POST, so a disallowed
 * Origin is a hard reject. Missing Origin (curl/server) is allowed through —
 * those clients still face the bot gate + rate limit.
 */
export const originStep: Step = async (ctx) => {
  const origin = getRequestHeader(ctx.event, "origin");
  if (!originAllowed(origin, ctx.profile.origins)) {
    return forbidden("Origin not allowed");
  }
  return undefined;
};
