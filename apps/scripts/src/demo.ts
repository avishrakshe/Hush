/**
 * One command for the live demo stack (Fuji unless --local):
 *
 *   price-bot → facilitator :4022 → provider :4021 (+ AlphaKing :4025) → desk :4023 → operator :4040 → Mirror :4033
 *   → Atlas :4031 + Veil :4032
 *
 * Then `pnpm web` and open http://localhost:3000/demo. Ctrl+C stops everything (whole process trees).
 *
 *   pnpm demo [--local] [--only price-bot,facilitator,provider,desk,operator,mirror,atlas,veil]
 *
 * Demo pacing defaults (override via env): AGENT_BRAIN=rules, AGENT_INTERVAL_SECONDS=15, RULES_MAX_AGE_SECONDS=20,
 * AGENT_DAILY_CAP_USD=3. Set AGENT_BRAIN=claude to let Claude make the buy/trade/hold calls instead. The agents run the
 * v2 trading strategy when the desk contracts are deployed (AGENT_STRATEGY=feed for the v1 data-only loop).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

const local = process.argv.includes("--local");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1]?.split(",")) : undefined;

const env = {
  ...process.env,
  AGENT_BRAIN: process.env.AGENT_BRAIN || "rules",
  AGENT_INTERVAL_SECONDS: process.env.AGENT_INTERVAL_SECONDS || "15",
  RULES_MAX_AGE_SECONDS: process.env.RULES_MAX_AGE_SECONDS || "20",
  AGENT_DAILY_CAP_USD: process.env.AGENT_DAILY_CAP_USD || "3",
  FORCE_COLOR: "1",
};

const SERVICES = [
  { name: "price-bot", color: 32, filter: "@hush/price-bot", script: "start" },
  { name: "facilitator", color: 36, filter: "@hush/facilitator", script: "start", health: `http://127.0.0.1:${process.env.FACILITATOR_PORT || 4022}/health` },
  { name: "provider", color: 33, filter: "@hush/provider-demo", script: "start", health: `http://127.0.0.1:${process.env.PROVIDER_PORT || 4021}/health` },
  { name: "desk", color: 96, filter: "@hush/desk", script: "start", health: `http://127.0.0.1:${process.env.DESK_PORT || 4023}/health` },
  { name: "operator", color: 35, filter: "@hush/operator", script: "start", health: `http://127.0.0.1:${process.env.OPERATOR_PORT || 4040}/health` },
  { name: "mirror", color: 91, filter: "@hush/mirror", script: "start", health: `http://127.0.0.1:${process.env.MIRROR_PORT || 4033}/health` },
  { name: "atlas", color: 31, filter: "@hush/agent", script: "atlas" },
  { name: "veil", color: 34, filter: "@hush/agent", script: "veil" },
] as const;

const children: ChildProcess[] = [];
let stopping = false;

function start(s: (typeof SERVICES)[number]) {
  const script = local ? `${s.script}:local` : s.script;
  // shell: pnpm is a .cmd shim on Windows
  const child = spawn("pnpm", ["--silent", "--filter", s.filter, script], { env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const tag = `\x1b[${s.color}m${s.name.padEnd(11)}\x1b[0m│ `;
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let rest = "";
    stream?.on("data", (buf: Buffer) => {
      const lines = (rest + buf.toString()).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) process.stdout.write(tag + line + "\n");
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (!stopping) process.stdout.write(`${tag}exited with code ${code}\n`);
  });
}

async function waitFor(url: string, name: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${name} did not come up at ${url}`);
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log("\nstopping demo stack…");
  for (const c of children) {
    if (!c.pid || c.exitCode !== null) continue;
    // Kill the whole tree: pnpm → tsx → node. On Windows child.kill() would only end the shell.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGINT");
  }
  setTimeout(() => process.exit(0), 1_500);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

console.log(`Hush demo stack on ${local ? "localhost" : "Fuji"} · brain ${env.AGENT_BRAIN} · tick ${env.AGENT_INTERVAL_SECONDS}s\n`);
for (const s of SERVICES) {
  if (only && !only.has(s.name)) continue;
  start(s);
  if ("health" in s) await waitFor(s.health, s.name);
}
console.log("\n  stack up → run `pnpm web` and open http://localhost:3000/demo   (Ctrl+C here stops everything)\n");
