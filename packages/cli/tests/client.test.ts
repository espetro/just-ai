import { describe, expect, it } from "vitest";

import { resolveAuthHeaders } from "../src/client";

describe("resolveAuthHeaders", () => {
  it("prefers the CF Access service token pair", () => {
    expect(
      resolveAuthHeaders({
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "secret",
        JUST_AI_ADMIN_TOKEN: "tok",
      }),
    ).toEqual({ "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" });
  });

  it("falls back to the bearer token", () => {
    expect(resolveAuthHeaders({ JUST_AI_ADMIN_TOKEN: "tok" })).toEqual({
      authorization: "Bearer tok",
    });
  });

  it("ignores a partial service token pair", () => {
    expect(resolveAuthHeaders({ CF_ACCESS_CLIENT_ID: "id", JUST_AI_ADMIN_TOKEN: "tok" })).toEqual({
      authorization: "Bearer tok",
    });
  });

  it("returns nothing when unauthenticated", () => {
    expect(resolveAuthHeaders({})).toEqual({});
  });
});
