/**
 * Drives the Hush MCP server exactly like a host (Claude Desktop, Claude Code) would: spawn it over stdio, list the
 * tools, then pay for the demo feed privately and inspect balance/history.
 * Usage: pnpm --filter @hush/mcp smoke [--local]   (provider + facilitator must be running)
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const local = process.argv.includes("--local");
const bin = fileURLToPath(new URL("../bin/hush-mcp.mjs", import.meta.url));
const feed = `${process.env.PROVIDER_URL || "http://localhost:4021"}/api/feed`;

const client = new Client({ name: "hush-smoke", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    cwd: path.dirname(bin),
    env: { ...(process.env as Record<string, string>), HUSH_NETWORK: local ? "localhost" : "fuji" },
  }),
);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args });
  const body = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  console.log(`── ${name}(${JSON.stringify(args)}) ${r.isError ? "ERROR " : ""}${Math.round(performance.now() - t0)} ms\n${body}\n`);
  return r;
};

await call("hush_pay", { url: feed, maxPrice: "0.01" }); // refused: price above cap, nothing paid
await call("hush_pay", { url: feed, maxPrice: "0.05" }); // first private payment (tops up if needed)
await call("hush_pay", { url: feed }); //                  voucher only
await call("hush_balance");
await call("hush_history", { limit: 5 });
await call("hush_verify");

await client.close();
process.exit(0);
