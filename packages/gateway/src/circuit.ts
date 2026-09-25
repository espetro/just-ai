import type { Storage } from "unstorage";

/**
 * Tiny circuit breaker on the shared unstorage mount. After `threshold`
 * consecutive dispatch failures a lane is skipped until `cooldownSec` elapses.
 * State is deliberately approximate — a lane that trips on one isolate may
 * still serve another on weakly-consistent backends; that's fine for failover.
 */
export function circuitBreaker(
  storage: Storage,
  opts: { threshold?: number; cooldownSec?: number } = {},
) {
  const threshold = opts.threshold ?? 3;
  const cooldownSec = opts.cooldownSec ?? 60;

  const failsKey = (lane: string) => `cb:${lane}:fails`;
  const openKey = (lane: string) => `cb:${lane}:openUntil`;

  return {
    async isOpen(lane: string): Promise<boolean> {
      const until = (await storage.getItem<number>(openKey(lane))) ?? 0;
      return until > Math.floor(Date.now() / 1000);
    },
    async recordSuccess(lane: string) {
      await storage.removeItem(failsKey(lane));
      await storage.removeItem(openKey(lane));
    },
    async recordFailure(lane: string) {
      const n = ((await storage.getItem<number>(failsKey(lane))) ?? 0) + 1;
      await storage.setItem(failsKey(lane), n, { ttl: cooldownSec * 2 });
      if (n >= threshold) {
        await storage.setItem(
          openKey(lane),
          Math.floor(Date.now() / 1000) + cooldownSec,
          { ttl: cooldownSec * 2 },
        );
      }
    },
  };
}
