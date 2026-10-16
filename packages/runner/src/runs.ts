import { join } from "node:path";
import { parsePlanProgress, type RunnerInput, type RunnerRunStatus, type RunnerStartRequest } from "@tac/shared";
import type { Exec } from "./exec";
import type { Git } from "./git";
import { HerdrError, type Herdr } from "./herdr";
import type { PromptBaseline, RunRecord, StateDir } from "./statefile";

/** The agent changed something since the prompt went out: a new PR, more ticked boxes, or a new commit. */
function changedSince(b: PromptBaseline | null, now: PromptBaseline): boolean {
  if (now.prUrl && now.prUrl !== (b?.prUrl ?? null)) return true;
  if (now.done > (b?.done ?? 0)) return true;
  return Boolean(b?.headSha && now.headSha && now.headSha !== b.headSha);
}

export class RunNotFound extends Error {
  constructor(runId: string) { super(`run ${runId} not found`); }
}

export interface RunManagerDeps { herdr: Herdr; git: Git; state: StateDir; worktreeRoot: string; exec: Exec; now?: () => number }

/** Below control's 5 s poll, so a retry is due on every poll rather than every other one. */
const RETRY_AFTER_MS = 4000;
const MAX_PROMPT_ATTEMPTS = 3;
/** How much of the prompt has to be on screen to count as seen. */
const PROMPT_MATCH_CHARS = 40;

const squash = (s: string) => s.replace(/[\s│]+/g, "");
const isRule = (line: string) => /^[╭╰]?─{10,}[╮╯]?$/.test(line.trim());

/**
 * Where the initial prompt is on the agent's screen (plain text): still in the input box, i.e. typed but not
 * submitted; only in the transcript above the box, i.e. submitted; or nowhere, i.e. dropped. The input box is the
 * text between the last two horizontal rules (Claude Code); without such a box any match counts as "input".
 * Matching uses the first PROMPT_MATCH_CHARS characters of the prompt with all whitespace removed, so wrapped lines match.
 */
export function locatePrompt(screen: string, prompt: string): "input" | "transcript" | "absent" {
  const head = squash(prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_MATCH_CHARS));
  if (!head) return "absent";
  const lines = screen.split("\n");
  const rules = lines.flatMap((l, i) => (isRule(l) ? [i] : []));
  if (rules.length < 2) return squash(screen).includes(head) ? "input" : "absent";
  const [top, bottom] = rules.slice(-2) as [number, number];
  if (squash(lines.slice(top + 1, bottom).join("")).includes(head)) return "input";
  return squash(lines.slice(0, top).join("")).includes(head) ? "transcript" : "absent";
}

export class RunManager {
  /** Runs whose agent launch is in flight in this process. */
  private launching = new Set<string>();

  constructor(private d: RunManagerDeps) {}

  private now() { return (this.d.now ?? Date.now)(); }

  /** Saves only while the state file exists, so a poll racing with cleanup does not bring the run back. */
  private persist(rec: RunRecord): boolean {
    if (!this.d.state.load(rec.runId)) return false;
    this.d.state.save(rec);
    return true;
  }

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

      const rec: RunRecord = {
        ...req, worktreePath, workspaceId, tabId, paneId, createdAt: this.now(),
        promptSent: false, promptSentAt: null, promptAcked: false, promptAttempts: 0, lastPromptAttemptAt: null, promptBaseline: null,
      };
      this.d.state.save(rec);
      return rec;
    } catch (e) {
      try { await this.d.git.removeWorktree(req.repoPath, worktreePath); } catch {}
      throw e;
    }
  }

  /**
   * Starts the agent (up to herdr's 60 s timeout). While this runs, status reports the agent as present. The
   * initial prompt is not sent here: status delivers it on the first idle poll after the launch, in one place
   * where every attempt is checked against the screen and retried.
   */
  async launch(rec: RunRecord): Promise<void> {
    this.launching.add(rec.runId);
    try {
      await this.d.herdr.startAgent(rec.runId, rec.agent, rec.paneId, rec.agentArgs);
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

    const observed = agent?.agentStatus ?? null;
    const planFile = Bun.file(join(rec.worktreePath, rec.planPath));
    const progress = (await planFile.exists()) ? parsePlanProgress(await planFile.text()) : null;

    let prUrl: string | null = null;
    try {
      const r = await this.d.exec(["gh", "pr", "list", "--head", rec.branch, "--state", "all", "--json", "url", "--limit", "1"], { cwd: rec.worktreePath });
      if (r.code === 0) prUrl = (JSON.parse(r.stdout) as { url: string }[])[0]?.url ?? null;
    } catch {}
    const headSha = await this.d.git.headSha(rec.worktreePath);
    const current: PromptBaseline = { prUrl, done: progress?.done ?? 0, headSha };

    if (!rec.promptAcked) {
      if (rec.promptSent && (observed === "working" || observed === "blocked" || changedSince(rec.promptBaseline, current))) {
        rec.promptAcked = true;
        this.persist(rec);
      } else if (agent && !launching && (observed === "idle" || observed === "done")) {
        // report working for the poll that gave the agent input, so control does not read the idle as finished
        if (await this.deliverPrompt(rec, current)) agentStatus = "working";
      }
    }
    // an unacknowledged prompt is not reported as sent until the attempts run out, so control does not start its idle timer
    const attemptsSpent = rec.promptAttempts >= MAX_PROMPT_ATTEMPTS && this.now() - (rec.lastPromptAttemptAt ?? 0) >= RETRY_AFTER_MS;

    return {
      runId, known: true, agentPresent: agent !== null || launching, agentStatus,
      promptSent: rec.promptSent && (rec.promptAcked || attemptsSpent),
      progress, prUrl, headSha,
    };
  }

  /**
   * One delivery attempt of the initial prompt to an idle agent: the first send, or a retry at least RETRY_AFTER_MS
   * after the previous attempt, MAX_PROMPT_ATTEMPTS in total. A retry reads the screen first: prompt still in the
   * input box -> Enter; prompt gone -> send it again; prompt already in the transcript -> acknowledged. Enter is
   * never pressed when the prompt text is not on screen. The attempt is counted before anything is sent, so a
   * failing herdr call cannot retry forever; agent_blocked does not count. Returns whether input went out.
   */
  private async deliverPrompt(rec: RunRecord, baseline: PromptBaseline): Promise<boolean> {
    const now = this.now();
    const first = !rec.promptSent;
    if (!first && (rec.promptAttempts >= MAX_PROMPT_ATTEMPTS || now - (rec.lastPromptAttemptAt ?? -Infinity) < RETRY_AFTER_MS)) return false;

    const before = { ...rec };
    if (first) { rec.promptSent = true; rec.promptSentAt = now; rec.promptBaseline = baseline; }
    rec.promptAttempts++; rec.lastPromptAttemptAt = now;
    if (!this.persist(rec)) return false;

    try {
      if (first) {
        await this.d.herdr.prompt(rec.runId, rec.prompt);
        return true;
      }
      const where = locatePrompt(await this.d.herdr.readPane(rec.paneId, 40, "text"), rec.prompt);
      if (where === "transcript") {
        Object.assign(rec, before, { promptAcked: true });
        this.persist(rec);
        return false;
      }
      if (where === "input") await this.d.herdr.sendKeys(rec.runId, ["enter"]);
      else await this.d.herdr.prompt(rec.runId, rec.prompt);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_blocked") {
        Object.assign(rec, before);
        this.persist(rec);
      } else {
        console.error(`run ${rec.runId}: initial prompt delivery attempt failed:`, e);
      }
      return false;
    }
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
