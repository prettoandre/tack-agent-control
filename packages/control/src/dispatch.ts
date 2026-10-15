import { branchName, newRunId, type AgentKind, type Run } from "@tac/shared";
import type { HostConfig, ProjectConfig } from "./config";
import type { RunnerClient } from "./runner-client";
import type { Store } from "./store";

export class DispatchError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface DispatchDeps {
  store: Store; projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig>;
  client: (host: string) => RunnerClient; now: () => number;
}

export function buildPrompt(planPath: string) {
  return `Execute the plan at ${planPath} using the superpowers:subagent-driven-development skill. When all tasks are done, open a pull request from the current branch.`;
}

export async function dispatch(d: DispatchDeps, input: { project: string; planPath: string; host?: string; agent?: AgentKind }): Promise<Run> {
  const p = d.projects.get(input.project);
  if (!p) throw new DispatchError("unknown_project", `unknown project ${input.project}`);
  const host = input.host && input.host !== "auto" ? input.host : p.host;
  if (!d.hosts.has(host)) throw new DispatchError("unknown_host", `unknown host ${host}`);

  const exists = await d.client(host).checkPlan({ repoPath: p.repoPath, baseBranch: p.baseBranch, planPath: input.planPath });
  if (!exists) throw new DispatchError("plan_not_found", `${input.planPath} is not on origin/${p.baseBranch}; commit and push it first`);

  const id = newRunId();
  const now = d.now();
  const run: Run = {
    id, project: p.name, host, agent: input.agent ?? p.agent, planPath: input.planPath, baseBranch: p.baseBranch,
    branch: branchName(id, input.planPath), state: "queued", prUrl: null, progress: null, idleSince: null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
  };
  d.store.insertRun(run);
  d.store.addEvent({ runId: id, at: now, kind: "dispatch", source: "user", data: { planPath: input.planPath, host } });
  return run;
}
