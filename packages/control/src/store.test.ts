import { expect, test } from "bun:test";
import type { Run } from "@tac/shared";
import { Store } from "./store";

export const run = (id: string, over: Partial<Run> = {}): Run => ({
  id, project: "p", host: "h1", agent: "claude", planPath: "a.md", baseBranch: "main", branch: `run/${id}-a`,
  state: "queued", prUrl: null, progress: null, idleSince: null, createdAt: 1, updatedAt: 1,
  startedAt: null, finishedAt: null, ...over,
});

test("insert, get, update with transition check", () => {
  const s = new Store(":memory:");
  s.insertRun(run("raaaaaaaa"));
  expect(s.updateRun("raaaaaaaa", { state: "preparing" }).state).toBe("preparing");
  expect(() => s.updateRun("raaaaaaaa", { state: "queued" })).toThrow("invalid transition");
  s.updateRun("raaaaaaaa", { progress: { waves: [], done: 1, total: 2 } });
  expect(s.getRun("raaaaaaaa")?.progress?.total).toBe(2);
});

test("capacity helpers", () => {
  const s = new Store(":memory:");
  s.insertRun(run("raaaaaaaa", { createdAt: 2 }));
  s.insertRun(run("rbbbbbbbb", { createdAt: 1 }));
  s.insertRun(run("rcccccccc", { state: "running" }));
  s.insertRun(run("rdddddddd", { state: "succeeded" }));
  s.insertRun(run("reeeeeeee", { host: "h2", state: "running" }));
  expect(s.countActive("h1")).toBe(1);
  expect(s.oldestQueued("h1")?.id).toBe("rbbbbbbbb");
});

test("events are append-only and ordered", () => {
  const s = new Store(":memory:");
  s.addEvent({ runId: "raaaaaaaa", at: 2, kind: "input", source: "user", data: { text: "b" } });
  s.addEvent({ runId: "raaaaaaaa", at: 1, kind: "state", source: "control", data: { to: "running" } });
  expect(s.events("raaaaaaaa").map((e) => e.at)).toEqual([1, 2]);
});
