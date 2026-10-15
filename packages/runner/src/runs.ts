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
  /** Runs whose agent launch is in flight in this process. */
  private launching = new Set<string>();

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

  /**
   * Everything up to a saved state file: plan check, worktree, workspace, tab. Fast enough for one HTTP request.
   * A failure after the worktree exists removes it again, so a retry does not find the branch checked out.
   */
  async prepare(req: RunnerStartRequest): Promise<RunRecord> {
    if (!(await this.checkPlan(req.repoPath, req.baseBranch, req.planPath)))
      throw new HerdrError("plan_not_found", `${req.planPath} is not on origin/${req.baseBranch}`);

    const worktreePath = join(this.d.worktreeRoot, req.project, req.runId);
    await this.d.git.addWorktree(req.repoPath, worktreePath, req.branch, req.baseBranch);

    try {
      const label = `tac:${req.project}`;
      const found = (await this.d.herdr.listWorkspaces()).find((w) => w.label === label);
      const workspaceId = found
        ? found.workspaceId
        : (await this.d.herdr.createWorkspace(join(this.d.worktreeRoot, req.project), label)).workspaceId;
      const { tabId, paneId } = await this.d.herdr.createTab(workspaceId, worktreePath, req.runId);

      const rec: RunRecord = { ...req, worktreePath, workspaceId, tabId, paneId, promptSent: false, createdAt: Date.now() };
      this.d.state.save(rec);
      return rec;
    } catch (e) {
      try { await this.d.git.removeWorktree(req.repoPath, worktreePath); } catch {}
      throw e;
    }
  }

  /**
   * Starts the agent (up to herdr's 60 s timeout) and sends the prompt when it is ready. While this runs,
   * status reports the agent as present and leaves the prompt to launch.
   */
  async launch(rec: RunRecord): Promise<void> {
    this.launching.add(rec.runId);
    try {
      const started = await this.d.herdr.startAgent(rec.runId, rec.agent, rec.paneId, rec.agentArgs);
      if (started === "ready") {
        await this.d.herdr.prompt(rec.runId, rec.prompt);
        rec.promptSent = true;
        this.d.state.save(rec);
      }
    } finally {
      this.launching.delete(rec.runId);
    }
  }

  async start(req: RunnerStartRequest): Promise<RunRecord> {
    const rec = await this.prepare(req);
    await this.launch(rec);
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

  async status(runId: string): Promise<RunnerRunStatus> {
    const rec = this.d.state.load(runId);
    if (!rec) return { runId, known: false, agentPresent: false, agentStatus: null, promptSent: false, progress: null, prUrl: null, headSha: null };

    const agent = await this.d.herdr.getAgent(runId);
    let agentStatus = agent?.agentStatus ?? null;
    const launching = this.launching.has(runId);
    // herdr may not list the agent yet; reporting it absent would make control fail the run
    if (launching && !agent) agentStatus = "unknown";

    if (agent && !launching && !rec.promptSent && (agentStatus === "idle" || agentStatus === "done")) {
      try {
        await this.d.herdr.prompt(runId, rec.prompt);
        rec.promptSent = true;
        this.d.state.save(rec);
        agentStatus = "working";
      } catch (e) {
        if (!(e instanceof HerdrError && e.code === "agent_blocked")) throw e;
      }
    }

    const planFile = Bun.file(join(rec.worktreePath, rec.planPath));
    const progress = (await planFile.exists()) ? parsePlanProgress(await planFile.text()) : null;

    let prUrl: string | null = null;
    try {
      const r = await this.d.exec(["gh", "pr", "list", "--head", rec.branch, "--state", "all", "--json", "url", "--limit", "1"], { cwd: rec.worktreePath });
      if (r.code === 0) prUrl = (JSON.parse(r.stdout) as { url: string }[])[0]?.url ?? null;
    } catch {}

    return {
      runId, known: true, agentPresent: agent !== null || launching, agentStatus, promptSent: rec.promptSent,
      progress, prUrl, headSha: await this.d.git.headSha(rec.worktreePath),
    };
  }

  async input(runId: string, input: RunnerInput): Promise<void> {
    const rec = this.record(runId);
    if (input.type === "prompt") return this.d.herdr.prompt(runId, input.text);
    if (input.type === "keys") return this.d.herdr.sendKeys(runId, input.keys);
    return this.d.herdr.sendText(rec.paneId, input.text);
  }

  async screen(runId: string, lines: number): Promise<string> {
    return this.d.herdr.readPane(this.record(runId).paneId, lines, "ansi");
  }
}
