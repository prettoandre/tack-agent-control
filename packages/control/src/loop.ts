import { ACTIVE_STATES, TERMINAL_STATES, type Run } from "@tac/shared";
import type { HostConfig, ProjectConfig } from "./config";
import { decide } from "./decide";
import { buildPrompt } from "./dispatch";
import type { RunnerClient } from "./runner-client";
import type { Store } from "./store";

export interface LoopDeps {
  store: Store; projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig>;
  client: (host: string) => RunnerClient; now: () => number; idleTimeoutMs: number;
}

export class ControlLoop {
  private failures = new Map<string, number>();
  private lastErrorAt = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private busy = false;

  constructor(private d: LoopDeps) {}

  hostState(host: string): "ok" | "unreachable" {
    return (this.failures.get(host) ?? 0) >= 3 ? "unreachable" : "ok";
  }

  async healthTick() {
    for (const host of this.d.hosts.keys()) {
      const ok = await this.d.client(host).health();
      this.failures.set(host, ok ? 0 : (this.failures.get(host) ?? 0) + 1);
    }
  }

  private setState(run: Run, patch: Partial<Run>) {
    const now = this.d.now();
    const terminal = patch.state && TERMINAL_STATES.includes(patch.state);
    const updated = this.d.store.updateRun(run.id, { ...patch, updatedAt: now, ...(terminal ? { finishedAt: now } : {}) });
    if (patch.state && patch.state !== run.state)
      this.d.store.addEvent({ runId: run.id, at: now, kind: "state", source: "control", data: { from: run.state, to: patch.state } });
    return updated;
  }

  private errorEvent(runId: string, code: string, message: string) {
    const now = this.d.now();
    if (now - (this.lastErrorAt.get(runId) ?? -Infinity) < 60_000) return;
    this.lastErrorAt.set(runId, now);
    this.d.store.addEvent({ runId, at: now, kind: "error", source: "control", data: { code, message } });
  }

  private async dispatchQueued() {
    for (const [host, cfg] of this.d.hosts) {
      if (this.hostState(host) !== "ok") continue;
      while (this.d.store.countActive(host) < cfg.maxRuns) {
        const run = this.d.store.oldestQueued(host);
        if (!run) break;
        const p = this.d.projects.get(run.project);
        const started = this.setState(run, { state: "preparing", startedAt: this.d.now() });
        try {
          if (!p) throw Object.assign(new Error(`unknown project ${run.project}`), { code: "unknown_project" });
          await this.d.client(host).start({
            runId: run.id, project: run.project, repoPath: p.repoPath, baseBranch: run.baseBranch,
            planPath: run.planPath, branch: run.branch, agent: run.agent, agentArgs: p.agentArgs, prompt: buildPrompt(run.planPath),
          });
        } catch (e: any) {
          this.setState(started, { state: "failed" });
          this.d.store.addEvent({ runId: run.id, at: this.d.now(), kind: "error", source: "control", data: { code: e?.code ?? "start_failed", message: String(e?.message ?? e) } });
        }
      }
    }
  }

  private async reconcile() {
    const active = this.d.store.listRuns({ states: [...ACTIVE_STATES], limit: 1000 });
    for (const run of active) {
      if (this.hostState(run.host) === "unreachable") {
        if (run.state !== "unknown") this.setState(run, { state: "unknown" });
        continue;
      }
      try {
        const s = await this.d.client(run.host).status(run.id);
        const next = decide(run, s, this.d.now(), this.d.idleTimeoutMs);
        const patch: Partial<Run> = {};
        if (next.state !== run.state) patch.state = next.state;
        if (next.idleSince !== run.idleSince) patch.idleSince = next.idleSince;
        if (s.prUrl && s.prUrl !== run.prUrl) patch.prUrl = s.prUrl;
        if (s.progress && JSON.stringify(s.progress) !== JSON.stringify(run.progress)) patch.progress = s.progress;
        if (Object.keys(patch).length) this.setState(run, patch);
      } catch (e: any) {
        this.errorEvent(run.id, e?.code ?? "status_failed", String(e?.message ?? e));
      }
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this.dispatchQueued(); await this.reconcile(); } finally { this.busy = false; }
  }

  start() {
    this.timers.push(setInterval(() => void this.tick(), 5_000), setInterval(() => void this.healthTick(), 15_000));
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
}
