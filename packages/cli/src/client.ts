/**
 * Admin API client for a deployed just-ai gateway.
 * Node-stdlib-only (fetch, process.env) — keeps the CLI compilable to a
 * single binary (bun --compile today, scriptc/perry later).
 *
 * Auth, in priority order:
 *   CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET  (Cloudflare Access service token)
 *   JUST_AI_ADMIN_TOKEN                            (bearer fallback)
 * Base URL: JUST_AI_BASE_URL or --base.
 */

export interface Client {
  base: string;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

export function resolveAuthHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return {
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    };
  }
  if (env.JUST_AI_ADMIN_TOKEN) return { authorization: `Bearer ${env.JUST_AI_ADMIN_TOKEN}` };
  return {};
}

export function adminClient(opts: { base?: string } = {}): Client {
  const base = (opts.base ?? process.env.JUST_AI_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) die("no gateway URL — set JUST_AI_BASE_URL or pass --base");

  const headers = resolveAuthHeaders();

  const req = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    base,
    get: (path) => req("GET", path),
    post: (path, body) => req("POST", path, body),
  };
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    die(`HTTP ${res.status} — non-JSON response`, text.slice(0, 200));
  }
  if (!res.ok) die(`HTTP ${res.status}`, JSON.stringify(json).slice(0, 300));
  return json as T;
}

export function die(msg: string, detail?: string): never {
  console.error(`error: ${msg}${detail ? `\n${detail}` : ""}`);
  process.exit(1);
}
