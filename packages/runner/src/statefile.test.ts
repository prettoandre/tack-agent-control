import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir, type RunRecord } from "./statefile";

const rec = (id: string): RunRecord => ({
  runId: id, project: "p", repoPath: "/r", baseBranch: "main", planPath: "a.md", branch: `run/${id}-a`,
  agent: "claude", agentArgs: [], prompt: "go", worktreePath: `/w/${id}`, workspaceId: "w1",
  tabId: "w1:t2", paneId: "w1:p2", promptSent: false, promptSentAt: null, promptAcked: false, nudgeCount: 0, lastNudgeAt: null, createdAt: 1,
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
  const { promptSentAt: _a, promptAcked: _b, nudgeCount: _c, lastNudgeAt: _d, ...old } = { ...rec("raaaaaaaa"), promptSent: true };
  writeFileSync(join(dir, "raaaaaaaa.json"), JSON.stringify(old));
  const s = new StateDir(dir);
  const want = { promptSent: true, promptSentAt: null, promptAcked: false, nudgeCount: 0, lastNudgeAt: null };
  expect(s.load("raaaaaaaa")).toMatchObject(want);
  expect(s.list()[0]).toMatchObject(want);
});
