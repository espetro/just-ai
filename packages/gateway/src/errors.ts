/** OpenAI-style error envelope so clients can reuse stock SDK error handling. */
export function gatewayError(
  status: number,
  message: string,
  type: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { message, type, code: status } },
    { status, headers },
  );
}

export function rateLimited(retryAfter: number): Response {
  return gatewayError(429, "Rate limit exceeded", "rate_limit_exceeded", {
    "Retry-After": String(retryAfter),
  });
}

export function forbidden(message = "Forbidden"): Response {
  return gatewayError(403, message, "forbidden");
}

export function badRequest(message: string): Response {
  return gatewayError(400, message, "invalid_request_error");
}

export function allLanesDown(): Response {
  return gatewayError(
    503,
    "All upstream providers are unavailable",
    "upstream_unavailable",
    { "Retry-After": "60" },
  );
}
