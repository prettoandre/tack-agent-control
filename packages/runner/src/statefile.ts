import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerStartRequest } from "@tac/shared";

export interface RunRecord extends RunnerStartRequest {
  worktreePath: string; workspaceId: string; tabId: string; paneId: string;
  promptSent: boolean; createdAt: number;
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
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunRecord) : null;
  }

  list(): RunRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RunRecord);
  }

  remove(runId: string) { rmSync(this.path(runId), { force: true }); }
}
