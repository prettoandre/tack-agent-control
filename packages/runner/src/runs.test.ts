import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerStartRequest } from "@tac/shared";
import { RunManager } from "./runs";
import { StateDir } from "./statefile";
import { HerdrError } from "./herdr";

export function fakes(opts: {
  planExists?: boolean; start?: "ready" | "blocked";
  /** startAgent waits on this before herdr knows the agent (a slow agent launch) */
  startGate?: Promise<void>;
  createTabFails?: boolean;
} = {}) {
  const log: string[] = [];
  const agents = new Map<string, { agentStatus: string; paneId: string; tabId: string }>();
  let ws: { workspaceId: string; label: string }[] = [];
  let tab = 1;
  const herdr: any = {
    listWorkspaces: async () => ws,
    createWorkspace: async (_: string, label: string) => { ws.push({ workspaceId: "w1", label }); log.push(`ws ${label}`); return { workspaceId: "w1", paneId: "w1:p1" }; },
    createTab: async (_w: string, cwd: string, label: string) => {
      if (opts.createTabFails) throw new HerdrError("tab_failed", "no tab");
      tab++; log.push(`tab ${label} ${cwd}`); return { tabId: `w1:t${tab}`, paneId: `w1:p${tab}` }; },
    closeTab: async (id: string) => { log.push(`close ${id}`); },
    startAgent: async (name: string, _k: string, paneId: string) => {
      if (opts.startGate) await opts.startGate;
      const st = opts.start ?? "ready";
      agents.set(name, { agentStatus: st === "ready" ? "idle" : "blocked", paneId, tabId: "" });
      log.push(`start ${name}`); return st;
    },
    getAgent: async (name: string) => {
      const a = agents.get(name);
      return a ? { name, agentStatus: a.agentStatus, paneId: a.paneId, tabId: a.tabId, workspaceId: "w1", cwd: "", launchPending: false } : null;
    },
    prompt: async (name: string, text: string) => {
      if (agents.get(name)?.agentStatus === "blocked") throw new HerdrError("agent_blocked", "blocked");
      log.push(`prompt ${name} ${text}`);
    },
    sendKeys: async (name: string, keys: string[]) => { log.push(`keys ${name} ${keys.join(" ")}`); },
    sendText: async (pane: string, text: string) => { log.push(`text ${pane} ${text}`); },
    readPane: async () => "screen",
  };
  const git: any = {
    fetch: async () => {},
    planExists: async () => opts.planExists ?? true,
    addWorktree: async (_r: string, w: string, b: string) => { log.push(`wt ${w} ${b}`); },
    removeWorktree: async (_r: string, w: string) => { log.push(`rmwt ${w}`); },
    headSha: async () => "a".repeat(40),
  };
  const state = new StateDir(mkdtempSync(join(tmpdir(), "tac-rm-")));
  const exec: any = async () => ({ code: 0, stdout: "[]", stderr: "" });
  const mgr = new RunManager({ herdr, git, state, worktreeRoot: "/wt", exec });
  return { mgr, log, agents, state };
}

export const req = (runId: string): RunnerStartRequest => ({
  runId, project: "proj", repoPath: "/repo", baseBranch: "main", planPath: "docs/p.md",
  branch: `run/${runId}-p`, agent: "claude", agentArgs: [], prompt: "execute docs/p.md",
});

test("start creates worktree, tab, agent and sends the prompt when ready", async () => {
  const { mgr, log, state } = fakes();
  await mgr.start(req("raaaaaaaa"));
  expect(log).toEqual([
    "wt /wt/proj/raaaaaaaa run/raaaaaaaa-p", "ws tac:proj", "tab raaaaaaaa /wt/proj/raaaaaaaa",
    "start raaaaaaaa", "prompt raaaaaaaa execute docs/p.md",
  ]);
  expect(state.load("raaaaaaaa")?.promptSent).toBe(true);
});

test("two runs of one project reuse the workspace and get separate worktrees", async () => {
  const { mgr, log } = fakes();
  await mgr.start(req("raaaaaaaa"));
  await mgr.start(req("rbbbbbbbb"));
  expect(log.filter((l) => l.startsWith("ws "))).toHaveLength(1);
  expect(log.filter((l) => l.startsWith("wt "))).toEqual([
    "wt /wt/proj/raaaaaaaa run/raaaaaaaa-p", "wt /wt/proj/rbbbbbbbb run/rbbbbbbbb-p",
  ]);
});

test("blocked startup leaves the prompt unsent", async () => {
  const { mgr, log, state } = fakes({ start: "blocked" });
  await mgr.start(req("raaaaaaaa"));
  expect(log.some((l) => l.startsWith("prompt"))).toBe(false);
  expect(state.load("raaaaaaaa")?.promptSent).toBe(false);
});

test("unpushed plan is rejected before anything is created", async () => {
  const { mgr, log, state } = fakes({ planExists: false });
  const err = await mgr.start(req("raaaaaaaa")).catch((e) => e);
  expect(err.code).toBe("plan_not_found");
  expect(log).toEqual([]);
  expect(state.list()).toEqual([]);
});

test("cleanup cancels, removes worktree and state", async () => {
  const { mgr, log, state } = fakes();
  await mgr.start(req("raaaaaaaa"));
  await mgr.cleanup("raaaaaaaa");
  expect(log).toContain("keys raaaaaaaa ctrl+c");
  expect(log).toContain("rmwt /wt/proj/raaaaaaaa");
  expect(state.load("raaaaaaaa")).toBeNull();
});

test("prepare saves the run without starting the agent; launch starts it and sends the prompt", async () => {
  const { mgr, log, state } = fakes();
  const rec = await mgr.prepare(req("raaaaaaaa"));
  expect(rec.worktreePath).toBe("/wt/proj/raaaaaaaa");
  expect(state.load("raaaaaaaa")?.promptSent).toBe(false);
  expect(log.some((l) => l.startsWith("start"))).toBe(false);
  await mgr.launch(rec);
  expect(log.slice(-2)).toEqual(["start raaaaaaaa", "prompt raaaaaaaa execute docs/p.md"]);
  expect(state.load("raaaaaaaa")?.promptSent).toBe(true);
});

test("a prepare failure after the worktree exists removes the worktree and saves nothing", async () => {
  const { mgr, log, state } = fakes({ createTabFails: true });
  const err = await mgr.prepare(req("raaaaaaaa")).catch((e) => e);
  expect(err.code).toBe("tab_failed");
  expect(log).toContain("rmwt /wt/proj/raaaaaaaa");
  expect(state.list()).toEqual([]);
});
