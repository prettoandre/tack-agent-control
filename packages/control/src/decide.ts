import type { Run, RunState, RunnerRunStatus } from "@tac/shared";

export function decide(run: Run, s: RunnerRunStatus, now: number, idleTimeoutMs: number): { state: RunState; idleSince: number | null } {
  const keep = { state: run.state, idleSince: run.idleSince };
  if (!s.known) {
    return run.startedAt !== null && now - run.startedAt > 60_000 ? { state: "failed", idleSince: null } : keep;
  }
  if (!s.agentPresent) return { state: s.prUrl ? "succeeded" : "failed", idleSince: null };
  const idle = s.agentStatus === "idle" || s.agentStatus === "done";
  if (s.prUrl && idle) return { state: "succeeded", idleSince: null };
  if (s.agentStatus === "blocked") return { state: "waiting_input", idleSince: null };
  if (s.agentStatus === "working") return { state: "running", idleSince: null };
  if (idle) {
    if (!s.promptSent) return keep;
    const idleSince = run.idleSince ?? now;
    return { state: now - idleSince >= idleTimeoutMs ? "needs_attention" : "finishing", idleSince };
  }
  return keep;
}
