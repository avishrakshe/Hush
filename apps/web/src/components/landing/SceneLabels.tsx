"use client";

import { LABELS, PROVIDER_DEFS, labelEls } from "./scene/coords";
import { useLanding } from "./state";

/** DOM labels for the 3D nodes; LabelProjector (inside the canvas) moves them every frame. */
export function SceneLabels() {
  return (
    <div className="absolute inset-0 hidden overflow-hidden md:block">
      {LABELS.map((label) => (
        <div
          key={label.id}
          ref={(el) => {
            if (el) labelEls.set(label.id, el);
            else labelEls.delete(label.id);
          }}
          className={`absolute left-0 top-0 whitespace-nowrap font-mono text-[10px] leading-snug tracking-wide opacity-0 will-change-transform ${
            label.anchor === "below" ? "text-center" : ""
          }`}
        >
          {label.id === "agent" ? <AgentLabel /> : <ProviderLabel index={Number(label.id.split("-")[1])} />}
        </div>
      ))}
    </div>
  );
}

function AgentLabel() {
  const hush = useLanding((s) => s.mode === "hush");
  return (
    <>
      <span className="text-cyan">agent 0x4a1e…09c9</span>
      <br />
      <span className="text-ink-faint">spent today </span>
      {hush ? <span className="text-violet">████ (encrypted)</span> : <span className="text-pink">3.41 USDC · 212 calls</span>}
    </>
  );
}

function ProviderLabel({ index }: { index: number }) {
  const p = PROVIDER_DEFS[index];
  if (!p) return null;
  return (
    <>
      <span className="text-ink">{p.name}</span>
      <br />
      <span className="text-ink-faint">{p.price} USDC/call</span>
    </>
  );
}
