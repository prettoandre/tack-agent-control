import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerStartRequest } from "@tac/shared";

export interface RunRecord extends RunnerStartRequest {
  worktreePath: string; workspaceId: string; tabId: string; paneId: string;
  promptSent: boolean; createdAt: number;
  /** When the initial prompt was sent; null for records saved before this was tracked. */
  promptSentAt: number | null;
  /** The agent was seen acting on the initial prompt (working, blocked, progress or a PR). */
  promptAcked: boolean;
  /** Enter nudges sent for an unsubmitted initial prompt, and when the last one went out. */
  nudgeCount: number; lastNudgeAt: number | null;
}

/** Fills the fields records saved by older runners lack. */
function normalize(raw: string): RunRecord {
  const r = JSON.parse(raw) as RunRecord;
  return { ...r, promptSentAt: r.promptSentAt ?? null, promptAcked: r.promptAcked ?? false, nudgeCount: r.nudgeCount ?? 0, lastNudgeAt: r.lastNudgeAt ?? null };
}

const ID = /^r[a-z0-9]{8}$/;

export class StateDir {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }

  private path(runId: string) {
    if (!ID.test(runId)) throw new Error("invalid run id");
    return join(this.dir, `${runId}.json`);
  }

  save(r: RunRecord) {
    const p = this.path(r.runId);
    writeFileSync(`${p}.tmp`, JSON.stringify(r, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  load(runId: string): RunRecord | null {
    const p = this.path(runId);
    return existsSync(p) ? (normalize(readFileSync(p, "utf8"))) : null;
  }

  list(): RunRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => normalize(readFileSync(join(this.dir, f), "utf8")));
  }

  remove(runId: string) { rmSync(this.path(runId), { force: true }); }
}
