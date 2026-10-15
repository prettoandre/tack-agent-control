import { expect, test } from "bun:test";
import type { RunnerRunStatus } from "@tac/shared";
import { decide } from "./decide";
import { run } from "./store.test";

const st = (o: Partial<RunnerRunStatus>): RunnerRunStatus => ({
  runId: "raaaaaaaa", known: true, agentPresent: true, agentStatus: "working", promptSent: true,
  progress: null, prUrl: null, headSha: null, ...o,
});
const T = 15 * 60_000;

test("working and blocked", () => {
  expect(decide(run("raaaaaaaa", { state: "preparing" }), st({}), 0, T).state).toBe("running");
  expect(decide(run("raaaaaaaa", { state: "running", idleSince: 5 }), st({ agentStatus: "blocked" }), 9, T))
    .toEqual({ state: "waiting_input", idleSince: null });
});

test("idle before the prompt is sent keeps the state", () => {
  expect(decide(run("raaaaaaaa", { state: "waiting_input" }), st({ agentStatus: "idle", promptSent: false }), 0, T).state).toBe("waiting_input");
});

test("idle without PR: finishing, then needs_attention after the timeout", () => {
  const r = run("raaaaaaaa", { state: "running" });
  expect(decide(r, st({ agentStatus: "idle" }), 1000, T)).toEqual({ state: "finishing", idleSince: 1000 });
  expect(decide({ ...r, state: "finishing", idleSince: 1000 }, st({ agentStatus: "done" }), 1000 + T, T).state).toBe("needs_attention");
});

test("PR wins; agent gone without PR fails", () => {
  expect(decide(run("raaaaaaaa", { state: "finishing" }), st({ agentStatus: "idle", prUrl: "https://x/pr/1" }), 0, T).state).toBe("succeeded");
  expect(decide(run("raaaaaaaa", { state: "running" }), st({ agentPresent: false, agentStatus: null }), 0, T).state).toBe("failed");
  expect(decide(run("raaaaaaaa", { state: "running" }), st({ agentPresent: false, agentStatus: null, prUrl: "u" }), 0, T).state).toBe("succeeded");
});

test("runner does not know the run: grace period, then failed", () => {
  const r = run("raaaaaaaa", { state: "preparing", startedAt: 0 });
  expect(decide(r, st({ known: false }), 30_000, T).state).toBe("preparing");
  expect(decide(r, st({ known: false }), 61_000, T).state).toBe("failed");
});
