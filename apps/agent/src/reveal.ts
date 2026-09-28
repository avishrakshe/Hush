/**
 * "Reveal as owner" from the command line: read an agent's telemetry stream and decrypt it locally with the owner's
 * (or the auditor's) eERC key. Anyone else sees only sealed blobs.
 *
 *   pnpm --filter @hush/agent reveal veil [--as owner|auditor] [--seconds 5] [--local]
 */
import { type Role, loadContracts, wallet } from "@hush/config";
import { type Sealed, isRecipient, unseal } from "@hush/x402";
import { PROFILES } from "./profiles.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const agentId = (args.find((a) => !a.startsWith("--") && a !== opt("as") && a !== opt("seconds")) ?? "veil") as keyof typeof PROFILES;
const profile = PROFILES[agentId];
if (!profile) throw new Error("usage: reveal atlas|veil [--as owner|auditor]");
const as = (opt("as") ?? "owner").toUpperCase() as Role;
const seconds = Number(opt("seconds") ?? 5);

const viewer = wallet(as).eerc(loadContracts());
await viewer.init(); // derives the viewer's eERC key from its wallet signature — nothing leaves this machine

const res = await fetch(`http://localhost:${profile.port}/events`);
if (!res.body) throw new Error(`agent ${profile.name} is not running on :${profile.port}`);
console.log(`Reading ${profile.name}'s telemetry as ${as.toLowerCase()} for ${seconds}s…\n`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const stopAt = Date.now() + seconds * 1000;
let shown = 0;

while (Date.now() < stopAt) {
  const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), stopAt - Date.now()))]);
  if (!chunk || chunk.done) break;
  buffer += decoder.decode(chunk.value, { stream: true });
  let idx: number;
  while ((idx = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const data = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!data) continue;
    const event = JSON.parse(data.slice(6)) as { id: number; at: number; type?: string; data?: unknown; sealed?: Sealed };
    const time = new Date(event.at).toISOString().slice(11, 19);
    if (!event.sealed) {
      console.log(`${time} #${event.id} ${event.type} ${JSON.stringify(event.data)}`);
    } else if (!isRecipient(viewer, event.sealed)) {
      console.log(`${time} #${event.id} 🔒 sealed (${event.sealed.ciphertext.slice(0, 18)}…) — not addressed to ${as.toLowerCase()}`);
    } else {
      const { type, data: payload } = JSON.parse(await unseal(viewer, event.sealed)) as { type: string; data: unknown };
      console.log(`${time} #${event.id} 🔓 ${type} ${JSON.stringify(payload)}`);
    }
    shown++;
  }
}
console.log(`\n${shown} event(s)`);
process.exit(0);
