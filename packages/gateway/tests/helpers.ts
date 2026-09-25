import { createStorage, type Storage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import { Readable } from "node:stream";
import type { GatewayContext, GatewayProfile } from "../src/types";

export function testProfile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    name: "test",
    origins: ["https://illo.fyi", "*.illo.fyi"],
    botGate: { type: "none" },
    rateLimit: {
      keyStrategy: "ip",
      store: "storage",
      windows: [{ name: "burst", limit: 3, windowSec: 60 }],
    },
    clamp: { maxTokens: 100, maxPromptBytes: 10_000, maxMessages: 10, stream: true },
    models: {
      "demo-chat": {
        lanes: [
          { provider: "lane-a", baseUrl: "https://a.example/v1", keyEnv: "KEY_A", model: "m-a" },
          { provider: "lane-b", baseUrl: "https://b.example/v1", keyEnv: "KEY_B", model: "m-b" },
        ],
      },
    },
    ...overrides,
  };
}

export function testContext(
  overrides: Partial<GatewayContext> = {},
  body?: unknown,
): GatewayContext {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
    },
    socket: { remoteAddress: "1.2.3.4" },
  });
  const env: Record<string, string> = { KEY_A: "k-a", KEY_B: "k-b" };
  return {
    event: {
      method: "POST",
      node: { req, res: {} },
      context: {},
    } as never,
    profile: testProfile(),
    env: {
      get: (n: string) => env[n],
      cfEnv: undefined,
    },
    storage: createStorage({ driver: memoryDriver() }) as Storage,
    requestId: "test-id",
    clientIp: "1.2.3.4",
    body: undefined,
    ...overrides,
  };
}
