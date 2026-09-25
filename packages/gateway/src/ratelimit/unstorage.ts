import { createStorage, type Storage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import type { RateWindow } from "../types";
import type { RateLimiter } from "./index";

/**
 * Fixed-window counter on any unstorage driver.
 *
 * get+set is not atomic, so on eventually-consistent backends (CF KV) a burst
 * can overshoot the limit slightly — acceptable for demo abuse control; use
 * the `redis`/`upstash` driver (atomic INCR) or the native `cf-binding` impl
 * when exactness matters.
 */
export function unstorageLimiter(storage: Storage): RateLimiter {
  return {
    async limit(key, window: RateWindow) {
      const now = Math.floor(Date.now() / 1000);
      const bucket = Math.floor(now / window.windowSec);
      const retryAfter = (bucket + 1) * window.windowSec - now;
      const k = `rl:${window.name}:${key}:${bucket}`;

      const n = ((await storage.getItem<number>(k)) ?? 0) + 1;
      await storage.setItem(k, n, { ttl: window.windowSec * 2 });
      return { success: n <= window.limit, retryAfter };
    },
  };
}

let sharedMemoryStorage: Storage | undefined;

/** Per-isolate store — counters are shared across requests on one isolate. */
export function memoryLimiter(): RateLimiter {
  sharedMemoryStorage ??= createStorage({ driver: memoryDriver() });
  return unstorageLimiter(sharedMemoryStorage);
}
