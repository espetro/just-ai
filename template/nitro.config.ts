// Build config — CF deployment config lives in wrangler.jsonc (merged into
// .output on build, read directly by wrangler CLI for dev/secret/deploy).
//
// Portability: NITRO_PRESET=node-server|bun|deno|vercel|netlify builds the
// same source for another runtime — only the storage driver + CF-only lanes
// differ.

const preset = process.env.NITRO_PRESET ?? "cloudflare_module";
const onCloudflare = preset.startsWith("cloudflare");

export default defineNitroConfig({
  compatibilityDate: "2025-09-19",
  preset,
  srcDir: "server",

  storage: {
    // Shared mount for rate-limit counters + provider circuit breakers.
    // CF deploys use KV; elsewhere memory (swap to "upstash"/"redis" for a
    // distributed non-CF deployment).
    ratelimit: onCloudflare
      ? { driver: "cloudflare-kv-binding", binding: "GATEWAY_KV" }
      : { driver: "memory" },
  },

  cloudflare: {
    deployConfig: true, // generate .output/wrangler.json, merging wrangler.jsonc
    nodeCompat: true,
  },
});
