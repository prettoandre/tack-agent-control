import { expect, test } from "bun:test";
import type { Exec } from "./exec";
import { Herdr, HerdrError } from "./herdr";

function stripSession(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") {
      i++; // also drop the session name
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

function fakeExec(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    const key = stripSession(cmd.slice(1)).join(" ");
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected command: ${key}`);
    return { code: hit[1].code ?? 0, stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "" };
  };
  return { exec, calls };
}

const AGENT = {
  agent: "claude", agent_status: "blocked", cwd: "/w", launch_pending: true, name: "rabc12345",
  pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
};

test("createWorkspace returns ids", async () => {
  const { exec } = fakeExec({
    "workspace create": { stdout: JSON.stringify({ id: "x", result: { workspace: { workspace_id: "w3" }, root_pane: { pane_id: "w3:p1" } } }) },
  });
  expect(await new Herdr(exec).createWorkspace("/w", "tac:proj")).toEqual({ workspaceId: "w3", paneId: "w3:p1" });
});

test("listWorkspaces maps ids and labels", async () => {
  const { exec } = fakeExec({
    "workspace list": { stdout: JSON.stringify({ result: { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "v" }] } }) },
  });
  expect(await new Herdr(exec).listWorkspaces()).toEqual([{ workspaceId: "w1", label: "v" }]);
});

test("createTab returns ids", async () => {
  const { exec, calls } = fakeExec({
    "tab create": { stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }) },
  });
  expect(await new Herdr(exec).createTab("w1", "/w", "t")).toEqual({ tabId: "w1:t2", paneId: "w1:p2" });
  expect(calls[0]).toEqual(["herdr", "tab", "create", "--workspace", "w1", "--cwd", "/w", "--label", "t"]);
});

test("closeTab passes the tab id", async () => {
  const { exec, calls } = fakeExec({ "tab close": { stdout: JSON.stringify({ result: { type: "ok" } }) } });
  await new Herdr(exec).closeTab("w1:t2");
  expect(calls[0]).toEqual(["herdr", "tab", "close", "w1:t2"]);
});

test("startAgent maps agent_not_ready to blocked and passes args after --", async () => {
  const { exec, calls } = fakeExec({
    "agent start": { code: 1, stderr: JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } }) },
  });
  expect(await new Herdr(exec).startAgent("rabc12345", "claude", "w1:p2", ["--model", "haiku"])).toBe("blocked");
  expect(calls[0]).toEqual(["herdr", "agent", "start", "rabc12345", "--kind", "claude", "--pane", "w1:p2", "--timeout", "60000", "--", "--model", "haiku"]);
});

test("getAgent returns null when the agent is gone", async () => {
  const { exec } = fakeExec({
    "agent get": { code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found", message: "x" } }) },
  });
  expect(await new Herdr(exec).getAgent("rabc12345")).toBeNull();
});

test("getAgent maps fields", async () => {
  const { exec } = fakeExec({ "agent get": { stdout: JSON.stringify({ result: { agent: AGENT } }) } });
  expect(await new Herdr(exec).getAgent("rabc12345")).toEqual({
    name: "rabc12345", agentStatus: "blocked", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/w", launchPending: true,
  });
});

test("prompt surfaces herdr error codes", async () => {
  const { exec } = fakeExec({
    "agent prompt": { code: 1, stderr: JSON.stringify({ error: { code: "agent_blocked", message: "needs input" } }) },
  });
  const err = await new Herdr(exec).prompt("rabc12345", "hi").catch((e) => e);
  expect(err).toBeInstanceOf(HerdrError);
  expect(err.code).toBe("agent_blocked");
});

test("readPane returns plain text", async () => {
  const { exec, calls } = fakeExec({ "pane read": { stdout: "hello\nworld\n" } });
  expect(await new Herdr(exec).readPane("w1:p2", 80, "ansi")).toBe("hello\nworld\n");
  expect(calls[0]).toEqual(["herdr", "pane", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "ansi"]);
});

test("session flag goes first", async () => {
  const { exec, calls } = fakeExec({ "agent list": { stdout: JSON.stringify({ result: { agents: [AGENT] } }) } });
  await new Herdr(exec, "herdr", "tac-test").listAgents();
  expect(calls[0]!.slice(0, 3)).toEqual(["herdr", "--session", "tac-test"]);
});
