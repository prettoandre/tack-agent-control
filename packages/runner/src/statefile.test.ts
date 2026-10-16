import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir, type RunRecord } from "./statefile";

const rec = (id: string): RunRecord => ({
  runId: id, project: "p", repoPath: "/r", baseBranch: "main", planPath: "a.md", branch: `run/${id}-a`,
  agent: "claude", agentArgs: [], prompt: "go", worktreePath: `/w/${id}`, workspaceId: "w1",
  tabId: "w1:t2", paneId: "w1:p2", promptSent: false, promptSentAt: null, promptAcked: false, promptAttempts: 0, lastPromptAttemptAt: null,
  promptBaseline: null, createdAt: 1,
});

test("save, load, list, remove", () => {
  const dir = mkdtempSync(join(tmpdir(), "tac-state-"));
  const s = new StateDir(dir);
  s.save(rec("raaaaaaaa")); s.save(rec("rbbbbbbbb"));
  expect(s.load("raaaaaaaa")?.branch).toBe("run/raaaaaaaa-a");
  expect(s.list().map((r) => r.runId).sort()).toEqual(["raaaaaaaa", "rbbbbbbbb"]);
  s.save({ ...rec("raaaaaaaa"), promptSent: true });
  expect(s.load("raaaaaaaa")?.promptSent).toBe(true);
  s.remove("raaaaaaaa");
  expect(s.load("raaaaaaaa")).toBeNull();
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("rejects ids that could escape the directory", () => {
  const s = new StateDir(mkdtempSync(join(tmpdir(), "tac-state-")));
  expect(() => s.load("../etc/passwd")).toThrow("invalid run id");
});

test("a record saved before prompt acknowledgement existed loads with defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "tac-state-"));
  const { promptSentAt: _a, promptAcked: _b, promptAttempts: _c, lastPromptAttemptAt: _d, promptBaseline: _e, ...old } = { ...rec("raaaaaaaa"), promptSent: true };
  writeFileSync(join(dir, "raaaaaaaa.json"), JSON.stringify(old));
  const s = new StateDir(dir);
  // the earlier send counts as one attempt, so the retries still stop at three in total
  const want = { promptSent: true, promptSentAt: null, promptAcked: false, promptAttempts: 1, lastPromptAttemptAt: null, promptBaseline: null };
  expect(s.load("raaaaaaaa")).toMatchObject(want);
  expect(s.list()[0]).toMatchObject(want);
});

test("a record from the nudge-based runner keeps its attempt count", () => {
  const dir = mkdtempSync(join(tmpdir(), "tac-state-"));
  const { promptAttempts: _c, lastPromptAttemptAt: _d, promptBaseline: _e, ...base } = rec("raaaaaaaa");
  writeFileSync(join(dir, "raaaaaaaa.json"), JSON.stringify({ ...base, promptSent: true, promptSentAt: 10, nudgeCount: 2, lastNudgeAt: 20 }));
  expect(new StateDir(dir).load("raaaaaaaa")).toMatchObject({ promptAttempts: 3, lastPromptAttemptAt: 20 });
});
