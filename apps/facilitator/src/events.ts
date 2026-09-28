import type { Request, Response } from "express";

export interface HushEvent {
  id: number;
  at: number;
  type: string;
  [k: string]: unknown;
}

/** JSON with bigints as decimal strings. */
export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * In-memory event bus behind `GET /events` (Server-Sent Events). Keeps a ring buffer so a freshly opened demo page
 * immediately shows recent history. Events carry only what the facilitator itself may publish: hush-credit calls
 * are published WITHOUT amounts (the public feed must show what an observer could learn, nothing more).
 */
export class EventHub {
  private nextId = 1;
  private readonly buffer: HushEvent[] = [];
  private readonly clients = new Set<Response>();

  constructor(private readonly capacity = 500) {}

  publish(type: string, data: Record<string, unknown> = {}) {
    const event: HushEvent = { ...data, id: this.nextId++, at: Date.now(), type };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    const frame = `id: ${event.id}\nevent: ${type}\ndata: ${toJson(event)}\n\n`;
    for (const res of this.clients) res.write(frame);
    return event;
  }

  recent(limit = 100) {
    return this.buffer.slice(-limit);
  }

  handler = (req: Request, res: Response) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    const since = Number(req.headers["last-event-id"] ?? req.query.since ?? 0);
    for (const e of this.buffer) if (e.id > since) res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${toJson(e)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  };
}
