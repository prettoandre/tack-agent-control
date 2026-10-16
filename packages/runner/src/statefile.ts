import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerStartRequest } from "@tac/shared";

/** What the run looked like when the initial prompt went out: only a change from it acknowledges the prompt. */
export interface PromptBaseline { prUrl: string | null; done: number; headSha: string | null }

export interface RunRecord extends RunnerStartRequest {
  worktreePath: string; workspaceId: string; tabId: string; paneId: string;
  /** The initial prompt went out at least once. */
  promptSent: boolean; createdAt: number;
  /** When the initial prompt first went out; null for records saved before this was tracked. */
  promptSentAt: number | null;
  /** The agent was seen acting on the initial prompt (working, blocked, a new PR, commit or ticked box). */
  promptAcked: boolean;
  /** Delivery attempts of the initial prompt (the first send plus retries), and when the last one went out. */
  promptAttempts: number; lastPromptAttemptAt: number | null;
  promptBaseline: PromptBaseline | null;
}

/** Fills the fields records saved by older runners lack. */
function normalize(raw: string): RunRecord {
  const { nudgeCount, lastNudgeAt, ...r } = JSON.parse(raw) as RunRecord & { nudgeCount?: number; lastNudgeAt?: number | null };
  return {
    ...r,
    promptSentAt: r.promptSentAt ?? null,
    promptAcked: r.promptAcked ?? false,
    // a nudge-based runner counted Enter nudges after the first send
    promptAttempts: r.promptAttempts ?? (r.promptSent ? 1 + (nudgeCount ?? 0) : 0),
    lastPromptAttemptAt: r.lastPromptAttemptAt ?? lastNudgeAt ?? r.promptSentAt ?? null,
    promptBaseline: r.promptBaseline ?? null,
  };
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
