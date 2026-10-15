import { expect, test } from "bun:test";
import type { RunnerRunStatus } from "@tac/shared";
import { ControlLoop } from "./loop";
import { Store } from "./store";
import { run } from "./store.test";

function setup(maxRuns = 2) {
  const store = new Store(":memory:");
  const calls: string[] = [];
  let healthy = true;
  const statuses = new Map<string, Partial<RunnerRunStatus>>();
  const client = () => ({
    health: async () => healthy,
    start: async (r: any) => { calls.push(`start ${r.runId}`); if (r.runId === "rfailfail") throw Object.assign(new Error("x"), { code: "git_error" }); },
    status: async (id: string) => ({ runId: id, known: true, agentPresent: true, agentStatus: "working", promptSent: true, progress: null, prUrl: null, headSha: null, ...statuses.get(id) }),
  }) as any;
  let now = 1_000;
  const loop = new ControlLoop({
    store, client, now: () => now, idleTimeoutMs: 60_000,
    projects: new Map([["p", { name: "p", host: "h1", repoPath: "/r", baseBranch: "main", agent: "claude" as const, agentArgs: [] }]]),
    hosts: new Map([["h1", { name: "h1", url: "http://x", token: "t", maxRuns }]]),
  });
  return { store, calls, loop, statuses, setHealthy: (v: boolean) => (healthy = v), advance: (ms: number) => (now += ms) };
}

test("dispatch respects maxRuns and order", async () => {
  const { store, calls, loop } = setup(2);
  store.insertRun(run("raaaaaaaa", { host: "h1", createdAt: 1 }));
  store.insertRun(run("rbbbbbbbb", { host: "h1", createdAt: 2 }));
  store.insertRun(run("rcccccccc", { host: "h1", createdAt: 3 }));
  await loop.tick();
  expect(calls).toEqual(["start raaaaaaaa", "start rbbbbbbbb"]);
  expect(store.getRun("rcccccccc")?.state).toBe("queued");
  expect(store.getRun("raaaaaaaa")?.state).toBe("running");
});

test("runner start error fails the run with an error event", async () => {
  const { store, loop } = setup();
  store.insertRun(run("rfailfail", { host: "h1" }));
  await loop.tick();
  expect(store.getRun("rfailfail")?.state).toBe("failed");
  expect(store.events("rfailfail").some((e) => e.kind === "error")).toBe(true);
});

test("unreachable host after 3 failed health checks moves runs to unknown, and back", async () => {
  const { store, loop, setHealthy } = setup();
  store.insertRun(run("raaaaaaaa", { host: "h1" }));
  await loop.tick();
  setHealthy(false);
  for (let i = 0; i < 3; i++) await loop.healthTick();
  expect(loop.hostState("h1")).toBe("unreachable");
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("unknown");
  setHealthy(true);
  await loop.healthTick();
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("running");
});

test("idle timeout leads to needs_attention", async () => {
  const { store, loop, statuses, advance } = setup();
  store.insertRun(run("raaaaaaaa", { host: "h1" }));
  await loop.tick();
  statuses.set("raaaaaaaa", { agentStatus: "idle" });
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("finishing");
  advance(60_000);
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("needs_attention");
});
