import type { RateWindow } from "../types";
import type { RateLimiter } from "./index";

interface CfRateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Native `ratelimits` binding — unmetered and edge-exact, but its window is
 * declared in wrangler config, so this impl ignores per-window profile values
 * (use exactly one RateWindow in the profile when store = cf-binding).
 * CF-only; skipped on other runtimes by createRateLimiter.
 */
export function cfBindingLimiter(binding: CfRateLimitBinding): RateLimiter {
  return {
    async limit(key, _window: RateWindow) {
      const { success } = await binding.limit({ key });
      return { success, retryAfter: 60 };
    },
  };
}
