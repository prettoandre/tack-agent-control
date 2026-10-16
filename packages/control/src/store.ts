import { Database } from "bun:sqlite";
import { ACTIVE_STATES, assertTransition, type Run, type RunEvent, type RunState } from "@tac/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL,
  plan_path TEXT NOT NULL, base_branch TEXT NOT NULL, branch TEXT NOT NULL, state TEXT NOT NULL,
  pr_url TEXT, progress TEXT, idle_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_host_state ON runs(host, state);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, at);
`;

const toRun = (r: any): Run => ({
  id: r.id, project: r.project, host: r.host, agent: r.agent, planPath: r.plan_path, baseBranch: r.base_branch,
  branch: r.branch, state: r.state, prUrl: r.pr_url, progress: r.progress ? JSON.parse(r.progress) : null,
  idleSince: r.idle_since, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, finishedAt: r.finished_at,
});
const COLS: Record<keyof Run, string> = {
  id: "id", project: "project", host: "host", agent: "agent", planPath: "plan_path", baseBranch: "base_branch",
  branch: "branch", state: "state", prUrl: "pr_url", progress: "progress", idleSince: "idle_since",
  createdAt: "created_at", updatedAt: "updated_at", startedAt: "started_at", finishedAt: "finished_at",
};
const val = (k: keyof Run, v: unknown) => (k === "progress" && v != null ? JSON.stringify(v) : v);

export class Store {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  insertRun(r: Run) {
    const keys = Object.keys(COLS) as (keyof Run)[];
    this.db.prepare(`INSERT INTO runs (${keys.map((k) => COLS[k]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => val(k, r[k]) as any));
  }

  getRun(id: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return r ? toRun(r) : null;
  }

  listRuns(opts: { states?: RunState[]; limit?: number } = {}): Run[] {
    const where = opts.states?.length ? `WHERE state IN (${opts.states.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(opts.states ?? []), opts.limit ?? 200).map(toRun);
  }

  updateRun(id: string, patch: Partial<Run>): Run {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run ${id} not found`);
    if (patch.state && patch.state !== cur.state) assertTransition(cur.state, patch.state);
    const next = { ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    const keys = (Object.keys(next) as (keyof Run)[]).filter((k) => k !== "id");
    this.db.prepare(`UPDATE runs SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => val(k, next[k]) as any), id);
    return this.getRun(id)!;
  }

  deleteRun(id: string) { this.db.prepare("DELETE FROM runs WHERE id = ?").run(id); }

  addEvent(e: RunEvent) {
    this.db.prepare("INSERT INTO run_events (run_id, at, kind, source, data) VALUES (?, ?, ?, ?, ?)")
      .run(e.runId, e.at, e.kind, e.source, JSON.stringify(e.data));
  }

  events(runId: string): RunEvent[] {
    return this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY at, id").all(runId)
      .map((r: any) => ({ runId: r.run_id, at: r.at, kind: r.kind, source: r.source, data: JSON.parse(r.data) }));
  }

  countActive(host: string): number {
    const q = `SELECT COUNT(*) AS n FROM runs WHERE host = ? AND state IN (${ACTIVE_STATES.map(() => "?").join(",")})`;
    return (this.db.prepare(q).get(host, ...ACTIVE_STATES) as { n: number }).n;
  }

  oldestQueued(host: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE host = ? AND state = 'queued' ORDER BY created_at ASC LIMIT 1").get(host);
    return r ? toRun(r) : null;
  }
}
