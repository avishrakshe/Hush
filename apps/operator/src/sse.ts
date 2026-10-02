/** JSON with bigints as decimal strings. */
export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Follows a Server-Sent Events stream over fetch and calls `onData` with each event's `data:` payload. Reconnects
 * (resuming with Last-Event-ID) until `signal` aborts, so an agent restarting mid-demo doesn't break the console.
 */
export async function followSse(
  url: string,
  onData: (data: string) => void | Promise<void>,
  opts: { signal: AbortSignal; onDown?: (err: Error) => void; retryMs?: number },
): Promise<void> {
  let lastId: string | undefined;
  while (!opts.signal.aborted) {
    try {
      const res = await fetch(url, { signal: opts.signal, headers: lastId ? { "last-event-id": lastId } : {} });
      if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) data += line.slice(6);
            else if (line.startsWith("id: ")) lastId = line.slice(4);
          }
          if (data) await onData(data);
        }
      }
      throw new Error(`${url}: stream ended`);
    } catch (err) {
      if (opts.signal.aborted) return;
      opts.onDown?.(err as Error);
    }
    await sleep(opts.retryMs ?? 2_000, opts.signal);
  }
}
