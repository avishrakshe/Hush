import { useSyncExternalStore } from "react";

export type Mode = "public" | "hush";

export interface LandingState {
  mode: Mode;
  /** True until the visitor touches the toggle: until then scrolling into THE VEIL switches to hush. */
  followScroll: boolean;
  /** 0 THE LEAK · 1 THE VEIL · 2 HOW IT WORKS · 3 PROOF */
  chapter: number;
}

const INITIAL: LandingState = { mode: "public", followScroll: true, chapter: 0 };
let state = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<LandingState>) {
  const next = { ...state, ...patch };
  if (next.mode === state.mode && next.followScroll === state.followScroll && next.chapter === state.chapter) return;
  state = next;
  for (const l of listeners) l();
}

/**
 * Continuous scroll position measured in chapters (0 → 4). Written on scroll and read every frame by the 3D scene;
 * it deliberately lives outside React so scrolling never re-renders anything.
 */
export const scrollState = { progress: 0 };

export const landing = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  setMode(mode: Mode, byUser = false) {
    set(byUser ? { mode, followScroll: false } : { mode });
  },
  toggle() {
    set({ mode: state.mode === "public" ? "hush" : "public", followScroll: false });
  },
  setChapter(chapter: number) {
    set({ chapter });
  },
};

export function useLanding<T>(select: (s: LandingState) => T): T {
  return useSyncExternalStore(
    landing.subscribe,
    () => select(state),
    () => select(INITIAL),
  );
}
