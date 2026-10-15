import { join } from "node:path";
import { parsePlanProgress, type RunnerInput, type RunnerRunStatus, type RunnerStartRequest } from "@tac/shared";
import type { Exec } from "./exec";
import type { Git } from "./git";
import { HerdrError, type Herdr } from "./herdr";
import type { RunRecord, StateDir } from "./statefile";

export class RunNotFound extends Error {
  constructor(runId: string) { super(`run ${runId} not found`); }
}

export interface RunManagerDeps { herdr: Herdr; git: Git; state: StateDir; worktreeRoot: string; exec: Exec }

export class RunManager {
  constructor(private d: RunManagerDeps) {}

  private record(runId: string): RunRecord {
    const r = this.d.state.load(runId);
    if (!r) throw new RunNotFound(runId);
    return r;
  }

  async checkPlan(repoPath: string, baseBranch: string, planPath: string) {
    await this.d.git.fetch(repoPath);
    return this.d.git.planExists(repoPath, baseBranch, planPath);
  }

  async start(req: RunnerStartRequest): Promise<RunRecord> {
    if (!(await this.checkPlan(req.repoPath, req.baseBranch, req.planPath)))
      throw new HerdrError("plan_not_found", `${req.planPath} is not on origin/${req.baseBranch}`);

    const worktreePath = join(this.d.worktreeRoot, req.project, req.runId);
    await this.d.git.addWorktree(req.repoPath, worktreePath, req.branch, req.baseBranch);

    const label = `tac:${req.project}`;
    const found = (await this.d.herdr.listWorkspaces()).find((w) => w.label === label);
    const workspaceId = found
      ? found.workspaceId
      : (await this.d.herdr.createWorkspace(join(this.d.worktreeRoot, req.project), label)).workspaceId;
    const { tabId, paneId } = await this.d.herdr.createTab(workspaceId, worktreePath, req.runId);

    const rec: RunRecord = { ...req, worktreePath, workspaceId, tabId, paneId, promptSent: false, createdAt: Date.now() };
    this.d.state.save(rec);

    const started = await this.d.herdr.startAgent(req.runId, req.agent, paneId, req.agentArgs);
    if (started === "ready") {
      await this.d.herdr.prompt(req.runId, req.prompt);
      rec.promptSent = true;
      this.d.state.save(rec);
    }
    return rec;
  }

  async cancel(runId: string) {
    const rec = this.record(runId);
    for (let i = 0; i < 2; i++) {
      try { await this.d.herdr.sendKeys(runId, ["ctrl+c"]); }
      catch (e) { if (!(e instanceof HerdrError && e.code === "agent_not_found")) throw e; }
    }
    try { await this.d.herdr.closeTab(rec.tabId); } catch {}
  }

  async cleanup(runId: string) {
    const rec = this.record(runId);
    if (await this.d.herdr.getAgent(runId)) await this.cancel(runId);
    await this.d.git.removeWorktree(rec.repoPath, rec.worktreePath);
    this.d.state.remove(runId);
  }

  // status, input, screen: Task 8
  async status(_runId: string): Promise<RunnerRunStatus> { throw new Error("not implemented"); }
  async input(_runId: string, _input: RunnerInput): Promise<void> { throw new Error("not implemented"); }
  async screen(_runId: string, _lines: number): Promise<string> { throw new Error("not implemented"); }
}
