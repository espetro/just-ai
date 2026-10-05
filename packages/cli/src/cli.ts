#!/usr/bin/env node
/**
 * just-ai — ops CLI for just-ai gateways.
 *
 *   just-ai status                     per-lane key/circuit table (admin API)
 *   just-ai config                     live model→lanes map (admin API)
 *   just-ai test [alias] [-p provider] probe one/all lanes end-to-end
 *   just-ai verify                     full battery: config + status + probes
 *   just-ai doctor [-f models.json]    local config + secrets sanity check
 *   just-ai tail <worker> [--filter s] wrangler tail, laneAttempt lines pretty
 *
 * Env: JUST_AI_BASE_URL, CF_ACCESS_CLIENT_ID/SECRET or JUST_AI_ADMIN_TOKEN.
 * Stdlib-only — compiles to a single binary (bun build --compile ./src/cli.ts).
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { adminClient, die, readJson } from "./client.js";

interface LaneStatus {
  provider: string;
  model: string;
  keyEnv?: string;
  keyless?: boolean;
  keyPresent: boolean;
  circuit: { open: boolean; openUntil?: number; fails: number };
}
interface StatusResponse {
  profile: string;
  models: Record<string, { lanes: LaneStatus[] }>;
}
interface ProbeResult {
  alias: string;
  provider: string;
  model: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

const ADMIN = "/admin/api";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    provider: { type: "string", short: "p" },
    file: { type: "string", short: "f" },
    filter: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [verb, ...rest] = positionals;
const client = () => adminClient({ base: values.base });
const print = (x: unknown) => console.log(values.json ? JSON.stringify(x) : fmt(x));

function fmt(x: unknown): string {
  return typeof x === "string" ? x : JSON.stringify(x, null, 2);
}

const pad = (s: string, n: number) => s.padEnd(n);

async function cmdStatus(): Promise<number> {
  const c = client();
  const st = await readJson<StatusResponse>(await c.get(`${ADMIN}/status`));
  if (values.json) return print(st), 0;
  console.log(`profile: ${st.profile}  (${c.base})`);
  for (const [alias, { lanes }] of Object.entries(st.models)) {
    console.log(`\n${alias}`);
    for (const l of lanes) {
      const key = l.keyless || l.keyPresent ? "key ✓" : l.keyEnv ? `${l.keyEnv} ✗` : "key -";
      const cb = l.circuit.open ? `circuit OPEN (fails=${l.circuit.fails})` : "circuit closed";
      console.log(`  ${pad(l.provider, 14)} ${pad(l.model, 34)} ${pad(key, 22)} ${cb}`);
    }
  }
  return 0;
}

async function cmdConfig(): Promise<number> {
  const c = client();
  const cfg = await readJson(await c.get(`${ADMIN}/config`));
  print(cfg);
  return 0;
}

async function cmdTest(): Promise<number> {
  const c = client();
  const res = await readJson<{ results: ProbeResult[] }>(
    await c.post(`${ADMIN}/test`, {
      alias: rest[0],
      provider: values.provider,
    }),
  );
  let bad = 0;
  for (const r of res.results) {
    bad += r.ok ? 0 : 1;
    const line = `${r.alias} → ${r.provider}/${r.model}  ${r.latencyMs}ms  status=${r.status ?? "-"} ${r.error ?? ""}`;
    values.json ? console.log(JSON.stringify(r)) : console.log(`${r.ok ? "ok  " : "FAIL"}  ${line}`);
  }
  return bad ? 1 : 0;
}

async function cmdVerify(): Promise<number> {
  let bad = 0;
  bad += await cmdStatus();
  bad += await cmdTest();
  console.log(bad ? `\nverify: ${bad} failing check(s)` : "\nverify: all green");
  return bad ? 1 : 0;
}

interface ModelsJson {
  models?: Record<string, { lanes?: Array<Record<string, unknown>> }>;
  [k: string]: unknown;
}

async function cmdDoctor(): Promise<number> {
  const file = values.file ?? "config/models.json";
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    die(`cannot read ${file}`);
  }
  let doc: ModelsJson;
  try {
    doc = JSON.parse(raw) as ModelsJson;
  } catch (e) {
    die(`${file}: invalid JSON`, (e as Error).message);
  }
  let bad = 0;
  const keyEnvs = new Set<string>();
  const laneCount = { aliases: 0, lanes: 0 };
  if (!doc.models || typeof doc.models !== "object") {
    console.error(`${file}: no top-level "models" object`);
    bad++;
  } else {
    for (const [alias, route] of Object.entries(doc.models)) {
      laneCount.aliases++;
      if (!route?.lanes?.length) {
        console.error(`${alias}: empty lane list`);
        bad++;
        continue;
      }
      for (const [i, l] of route.lanes.entries()) {
        laneCount.lanes++;
        if (typeof l.provider !== "string" || !l.provider) {
          console.error(`${alias} lane[${i}]: missing provider`);
          bad++;
        }
        if (typeof l.model !== "string" || !l.model) {
          console.error(`${alias} lane[${i}]: missing model`);
          bad++;
        }
        if (typeof l.keyEnv === "string") keyEnvs.add(l.keyEnv);
      }
    }
  }
  console.log(
    `${file}: ${laneCount.aliases} alias(es), ${laneCount.lanes} lane(s) — structure ${bad ? "FAIL" : "ok"}`,
  );
  if (keyEnvs.size) {
    console.log(`keyEnvs referenced: ${[...keyEnvs].join(", ")}`);
  }
  if (bad) console.log("note: CI runs authoritative parseModelsJson validation on PRs");
  return bad ? 1 : 0;
}

async function cmdTail(): Promise<number> {
  const name = rest[0];
  if (!name) die("tail needs a worker name: just-ai tail <worker> [--filter str]");
  const needle = values.filter ?? "laneAttempt";
  const proc = spawn("wrangler", ["tail", name, "--format", "json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  proc.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { logs?: Array<{ message?: unknown[] }> };
        for (const log of entry.logs ?? []) {
          for (const m of log.message ?? []) {
            const s = typeof m === "string" ? m : JSON.stringify(m);
            if (s.includes(needle)) {
              try {
                const j = JSON.parse(s.slice(s.indexOf("{")));
                console.log(
                  `${j.outcome ?? "?"}  ${j.alias ?? ""} → ${j.provider ?? ""}/${j.model ?? ""}  ${j.latencyMs ?? ""}ms ${j.status ?? ""}`,
                );
              } catch {
                console.log(s);
              }
            }
          }
        }
      } catch {
        // non-JSON tail line — skip
      }
    }
  });
  process.on("SIGINT", () => proc.kill());
  return new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 0)));
}

async function main(): Promise<number> {
  if (values.help || !verb) {
    console.log(`just-ai — ops CLI for just-ai gateways

  status                    per-lane key/circuit table
  config                    live model→lanes map
  test [alias] [-p lane]    probe lanes end-to-end (bypasses failover)
  verify                    status + probes battery
  doctor [-f models.json]   local config structure check
  tail <worker> [--filter]  wrangler tail, laneAttempt lines pretty

flags: --base URL (or JUST_AI_BASE_URL)  --json
auth:  CF_ACCESS_CLIENT_ID/SECRET or JUST_AI_ADMIN_TOKEN`);
    return verb ? 0 : 1;
  }
  switch (verb) {
    case "status": return cmdStatus();
    case "config": return cmdConfig();
    case "test": return cmdTest();
    case "verify": return cmdVerify();
    case "doctor": return cmdDoctor();
    case "tail": return cmdTail();
    default:
      die(`unknown command: ${verb}`);
  }
}

process.exitCode = await main();
