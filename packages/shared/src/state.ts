import type { RunState } from "./types";

const ALLOWED: Record<RunState, readonly RunState[]> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["running", "waiting_input", "failed", "cancelled", "unknown"],
  running: ["waiting_input", "finishing", "succeeded", "failed", "cancelled", "unknown"],
  waiting_input: ["running", "finishing", "succeeded", "failed", "cancelled", "unknown"],
  finishing: ["running", "waiting_input", "succeeded", "needs_attention", "failed", "cancelled", "unknown"],
  needs_attention: ["running", "waiting_input", "succeeded", "failed", "cancelled", "unknown"],
  unknown: ["preparing", "running", "waiting_input", "finishing", "needs_attention", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new Error(`invalid transition ${from} -> ${to}`);
}
