/** USDC atomic units (6 dp) → "0.02". Trailing zeros trimmed, at least 2 decimals. */
export function usdc(atomic: bigint | string | number, digits = 2): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(String(atomic).split(".")[0] || "0");
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}.${frac.padEnd(digits, "0")}`;
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });

export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function median(xs: number[]) {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
