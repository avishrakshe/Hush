/**
 * Where the live demo's local services run. Defaults match `pnpm demo`; override with NEXT_PUBLIC_* in
 * apps/web/.env.local when they live elsewhere.
 */
export const SERVICES = {
  facilitator: process.env.NEXT_PUBLIC_FACILITATOR_URL || "http://localhost:4022",
  provider: process.env.NEXT_PUBLIC_PROVIDER_URL || "http://localhost:4021",
  alphaking: process.env.NEXT_PUBLIC_ALPHAKING_URL || "http://localhost:4025",
  desk: process.env.NEXT_PUBLIC_DESK_URL || "http://localhost:4023",
  mirror: process.env.NEXT_PUBLIC_MIRROR_URL || "http://localhost:4033",
  operator: process.env.NEXT_PUBLIC_OPERATOR_URL || "http://localhost:4040",
  atlas: process.env.NEXT_PUBLIC_ATLAS_URL || "http://localhost:4031",
  veil: process.env.NEXT_PUBLIC_VEIL_URL || "http://localhost:4032",
} as const;
export type ServiceName = keyof typeof SERVICES;

export const FUJI_RPC = process.env.NEXT_PUBLIC_FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
export const LOCAL_RPC = process.env.NEXT_PUBLIC_LOCAL_RPC_URL || "http://127.0.0.1:8545";

export type AgentId = "atlas" | "veil";
export const AGENT_META: Record<AgentId, { name: string; scheme: string; blurb: string }> = {
  atlas: { name: "Atlas", scheme: "x402 exact", blurb: "public x402 — every signal, trade and position is a plain on-chain transfer" },
  veil: { name: "Veil", scheme: "hush-credit · hush-rfq", blurb: "Hush — encrypted top-ups, off-chain vouchers, custodied positions" },
};

/** Typed client for the local operator (apps/operator). POSTs carry the header that blocks cross-site requests. */
export async function operator<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`${SERVICES.operator}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.method === "POST" ? { "content-type": "application/json", "x-hush-operator": "1" } : undefined,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `operator ${path}: HTTP ${res.status}`);
  return body;
}

export async function getJson<T>(url: string, timeoutMs = 2_500): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function ping(url: string, timeoutMs = 2_500): Promise<boolean> {
  return (await getJson(url, timeoutMs)) !== null;
}
