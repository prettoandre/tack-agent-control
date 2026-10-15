import { expect, test } from "bun:test";
import type { RunnerRunStatus } from "@tac/shared";
import { ControlLoop } from "./loop";
import { RunnerCallError } from "./runner-client";
import { Store } from "./store";
import { run } from "./store.test";

function setup(maxRuns = 2, startImpl?: (r: any) => Promise<void>) {
  const store = new Store(":memory:");
  const calls: string[] = [];
  let healthy = true;
  const statuses = new Map<string, Partial<RunnerRunStatus>>();
  const client = () => ({
    health: async () => healthy,
    start: async (r: any) => {
      calls.push(`start ${r.runId}`);
      if (startImpl) return startImpl(r);
      if (r.runId === "rfailfail") throw new RunnerCallError(500, "git_error", "x");
    },
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

test("start that never got an answer from the runner leaves the run preparing with an error event", async () => {
  const { store, loop, statuses, advance } = setup(2, async () => {
    throw Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" });
  });
  store.insertRun(run("raaaaaaaa", { host: "h1" }));
  statuses.set("raaaaaaaa", { known: false, agentPresent: false, agentStatus: null, promptSent: false });
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("preparing");
  const errors = store.events("raaaaaaaa").filter((e) => e.kind === "error");
  expect(errors.map((e) => (e.data as any).code)).toEqual(["ECONNRESET"]);
  // the runner never learned about the run: decide() fails it after 60 s
  advance(61_000);
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("failed");
});

test("a start timeout without an error code is recorded as start_unreachable", async () => {
  const { store, loop, statuses } = setup(2, async () => { throw new DOMException("The operation timed out.", "TimeoutError"); });
  store.insertRun(run("raaaaaaaa", { host: "h1" }));
  statuses.set("raaaaaaaa", { known: false, agentPresent: false, agentStatus: null, promptSent: false });
  await loop.tick();
  expect(store.getRun("raaaaaaaa")?.state).toBe("preparing");
  expect(store.events("raaaaaaaa").filter((e) => e.kind === "error").map((e) => (e.data as any).code)).toEqual(["start_unreachable"]);
});

test("a run cancelled while its start is in flight stays cancelled when the start then fails", async () => {
  let fail!: (e: Error) => void;
  const { store, loop } = setup(2, () => new Promise<void>((_, rej) => (fail = rej)));
  store.insertRun(run("raaaaaaaa", { host: "h1" }));
  const ticking = loop.tick();
  await Bun.sleep(0);
  expect(store.getRun("raaaaaaaa")?.state).toBe("preparing");
  store.updateRun("raaaaaaaa", { state: "cancelled", finishedAt: 2_000 });   // what the cancel route does
  fail(new RunnerCallError(409, "agent_not_found", "gone"));
  await ticking;
  expect(store.getRun("raaaaaaaa")?.state).toBe("cancelled");
  expect(store.events("raaaaaaaa").some((e) => e.kind === "error" && (e.data as any).code === "agent_not_found")).toBe(true);
});

test("errors thrown inside the interval ticks are logged, never left unhandled", async () => {
  const { loop } = setup();
  (loop as any).tick = async () => { throw new Error("tick boom"); };
  (loop as any).healthTick = async () => { throw new Error("health boom"); };
  const callbacks: (() => void)[] = [];
  const realSetInterval = globalThis.setInterval;
  const realError = console.error;
  const logged: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  (globalThis as any).setInterval = (fn: () => void) => { callbacks.push(fn); return 0; };
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    loop.start();
    for (const cb of callbacks) cb();
    await Bun.sleep(10);
  } finally {
    globalThis.setInterval = realSetInterval;
    console.error = realError;
    process.off("unhandledRejection", onUnhandled);
    loop.stop();
  }
  expect(callbacks).toHaveLength(2);
  expect(unhandled).toEqual([]);
  expect(logged.some((l) => l.includes("tick boom"))).toBe(true);
  expect(logged.some((l) => l.includes("health boom"))).toBe(true);
});
