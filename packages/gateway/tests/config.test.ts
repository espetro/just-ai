import { describe, expect, it } from "vitest";
import { parseModelsJson } from "../src/config";
import { createGateway } from "../src/createGateway";
import { testContext, testProfile } from "./helpers";

describe("parseModelsJson", () => {
  it("parses a valid JSON doc into model routes", () => {
    const models = parseModelsJson(
      JSON.stringify({
        chat: {
          lanes: [
            { provider: "groq", model: "m1" },
            { provider: "custom", baseUrl: "https://x/v1", keyEnv: "X_KEY", model: "m2" },
          ],
        },
      }),
    );
    expect(models.chat.lanes).toHaveLength(2);
    expect(models.chat.lanes[1].baseUrl).toBe("https://x/v1");
    expect(models.chat.lanes[1].keyEnv).toBe("X_KEY");
  });

  it("accepts an object directly", () => {
    const models = parseModelsJson({ a: { lanes: [{ provider: "p", model: "m" }] } });
    expect(models.a.lanes[0].provider).toBe("p");
  });

  it("rejects malformed docs", () => {
    for (const bad of [
      null,
      [],
      {},
      { a: {} },
      { a: { lanes: [] } },
      { a: { lanes: [{ model: "m" }] } },
      { a: { lanes: [{ provider: "p" }] } },
      "not-json{",
    ]) {
      expect(() => parseModelsJson(bad)).toThrow();
    }
  });
});

describe("async profile resolver", () => {
  it("awaits the resolver before running the pipeline", async () => {
    const ctx = testContext();
    const handler = createGateway({
      profile: async () => testProfile(),
      storage: ctx.storage,
    });
    const res = await handler(ctx.event);
    // Reaches origin/clamp stage rather than crashing on a missing profile —
    // empty body → 400 proves profile resolution + pipeline ran.
    expect(res.status).toBe(400);
  });
});
