import { type EercAccount, type Sealed, seal } from "@hush/x402";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export interface AgentEvent {
  id: number;
  at: number;
  agent: string;
  /** Plaintext event (Atlas — its payments are public anyway). */
  type?: string;
  data?: Record<string, unknown>;
  /** Sealed event (Veil) — `{ type, data }` encrypted to the owner's and auditor's eERC keys. */
  sealed?: Sealed;
}

/**
 * The agent's own event stream (`GET /events`, SSE) + `GET /state` + `GET /health`.
 * With a `sealer`, every event — including its type — is encrypted so only the owner/auditor can read it.
 */
export class Telemetry {
  private nextId = 1;
  private readonly buffer: AgentEvent[] = [];
  private readonly clients = new Set<ServerResponse>();
  private latestState: unknown;

  constructor(
    private readonly agent: string,
    private readonly sealer?: { account: EercAccount; recipients: bigint[][] },
    private readonly info: Record<string, unknown> = {},
  ) {}

  async publish(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const base = { id: this.nextId++, at: Date.now(), agent: this.agent };
    let event: AgentEvent;
    try {
      event = this.sealer
        ? { ...base, sealed: await seal(this.sealer.account, this.sealer.recipients, toJson({ type, data })) }
        : { ...base, type, data };
    } catch (err) {
      console.error(`telemetry: could not seal ${type}: ${(err as Error).message}`);
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length > 300) this.buffer.shift();
    const frame = `id: ${event.id}\ndata: ${toJson(event)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  /** Latest agent state for `GET /state` — sealed too when the agent is private. */
  async setState(state: Record<string, unknown>) {
    this.latestState = this.sealer
      ? { agent: this.agent, at: Date.now(), sealed: await seal(this.sealer.account, this.sealer.recipients, toJson(state)) }
      : state;
  }

  listen(port: number) {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("access-control-allow-origin", "*");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
        for (const e of this.buffer) if (e.id > since) res.write(`id: ${e.id}\ndata: ${toJson(e)}\n\n`);
        this.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          this.clients.delete(res);
        });
        return;
      }
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/state") return void res.end(toJson(this.latestState ?? null));
      if (url.pathname === "/health") return void res.end(toJson({ ok: true, agent: this.agent, sealed: !!this.sealer, ...this.info }));
      res.statusCode = 404;
      res.end(toJson({ error: "not found" }));
    });
    server.listen(port);
    return server;
  }
}
