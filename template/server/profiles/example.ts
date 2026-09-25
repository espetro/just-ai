import { defineGatewayProfile } from "@just-ai/gateway";

/**
 * Example profile — replace with your project's wiring:
 * allowed origins, bot gate, rate-limit windows, clamps, and the public
 * model alias → ordered provider lane chain. Upstream provider ids never
 * reach the wire; clients only see the alias.
 */
export const exampleProfile = defineGatewayProfile({
  name: "example",

  origins: [
    "https://example.com",
    "*.example.com",
    "http://localhost:5173", // dev convenience — remove per-project
  ],

  botGate: {
    type: "turnstile", // or "none" for server-to-server profiles
    secretEnv: "TURNSTILE_SECRET_KEY",
    allowedHostnames: ["example.com"],
  },

  rateLimit: {
    keyStrategy: "ip",
    store: "auto", // native ratelimits binding on CF, unstorage elsewhere
    windows: [
      { name: "burst", limit: 10, windowSec: 60 },
      { name: "daily", limit: 30, windowSec: 86_400 },
    ],
  },

  clamp: {
    maxTokens: 1024,
    maxPromptBytes: 32_768,
    maxMessages: 50,
    stream: true,
  },

  models: {
    chat: {
      lanes: [
        // Ordered failover — first lane wins, later lanes take over on
        // errors/429/5xx or open circuit. openaiCompat covers any
        // OpenAI-shaped endpoint; cf-ai uses the Workers AI binding (CF only).
        { provider: "groq", model: "openai/gpt-oss-120b" },
        { provider: "zai", model: "glm-4.7-flash" },
        { provider: "google", model: "gemini-2.5-flash-lite" },
        { provider: "cf-ai", model: "@cf/meta/llama-3.2-3b-instruct" },
      ],
    },
  },
});
