import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "./runs";
import { HerdrError } from "./herdr";
import { fakes, req } from "./runs.test";

test("unknown run reports known=false", async () => {
  const { mgr } = fakes();
  expect((await mgr.status("rzzzzzzzz")).known).toBe(false);
});

test("blocked startup: prompt is sent on the first idle poll, not before", async () => {
  const { mgr, log, agents, state } = fakes({ start: "blocked" });
  await mgr.start(req("raaaaaaaa"));
  let s = await mgr.status("raaaaaaaa");
  expect(s.agentStatus).toBe("blocked");
  expect(s.promptSent).toBe(false);
  agents.get("raaaaaaaa")!.agentStatus = "idle";   // user answered the trust dialog
  s = await mgr.status("raaaaaaaa");
  expect(log).toContain("prompt raaaaaaaa execute docs/p.md");
  expect(s.promptSent).toBe(false);   // sent, but not yet acknowledged by the agent
  expect(s.agentStatus).toBe("working");
  expect(state.load("raaaaaaaa")).toMatchObject({ promptSent: true, promptSentAt: 1_000_000, promptAcked: false });
});

test("a new RunManager over the same state dir reports the same run (runner restart)", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  f.agents.get("raaaaaaaa")!.agentStatus = "working";
  await f.mgr.status("raaaaaaaa");   // acknowledged
  const restarted = new RunManager({ ...(f.mgr as any).d });
  const s = await restarted.status("raaaaaaaa");
  expect(s.known).toBe(true);
  expect(s.agentPresent).toBe(true);
  expect(s.promptSent).toBe(true);
});

test("agent gone is reported as not present", async () => {
  const { mgr, agents } = fakes();
  await mgr.start(req("raaaaaaaa"));
  agents.delete("raaaaaaaa");
  const s = await mgr.status("raaaaaaaa");
  expect(s.known).toBe(true);
  expect(s.agentPresent).toBe(false);
  expect(s.agentStatus).toBeNull();
});

test("input routes each type and propagates herdr codes", async () => {
  const { mgr, log, agents } = fakes();
  await mgr.start(req("raaaaaaaa"));
  await mgr.input("raaaaaaaa", { type: "keys", keys: ["down", "enter"] });
  await mgr.input("raaaaaaaa", { type: "text", text: "y" });
  expect(log).toContain("keys raaaaaaaa down enter");
  expect(log.some((l) => l.startsWith("text w1:p") && l.endsWith(" y"))).toBe(true);
  agents.get("raaaaaaaa")!.agentStatus = "blocked";
  const err = await mgr.input("raaaaaaaa", { type: "prompt", text: "hi" }).catch((e) => e);
  expect(err.code).toBe("agent_blocked");
});

test("while the agent launch is in flight, status keeps the run alive and never sends the prompt", async () => {
  let release!: () => void;
  const f = fakes({ startGate: new Promise<void>((r) => (release = r)) });
  const rec = await f.mgr.prepare(req("raaaaaaaa"));
  const launched = f.mgr.launch(rec);

  // herdr does not know the agent yet: it must not look gone, or control fails the run
  let s = await f.mgr.status("raaaaaaaa");
  expect(s).toMatchObject({ known: true, agentPresent: true, agentStatus: "unknown", promptSent: false });

  // herdr already lists the agent as idle: launch owns the first prompt, so status must not send it too
  f.agents.set("raaaaaaaa", { agentStatus: "idle", paneId: rec.paneId, tabId: rec.tabId });
  s = await f.mgr.status("raaaaaaaa");
  expect(s.promptSent).toBe(false);
  expect(f.log.some((l) => l.startsWith("prompt"))).toBe(false);

  release();
  await launched;
  expect(f.log.filter((l) => l.startsWith("prompt"))).toEqual(["prompt raaaaaaaa execute docs/p.md"]);
  expect(f.state.load("raaaaaaaa")?.promptSent).toBe(true);
});

const poll = async (f: ReturnType<typeof fakes>, advanceMs = 0) => { f.clock.now += advanceMs; return f.mgr.status("raaaaaaaa"); };
const nudges = (f: ReturnType<typeof fakes>) => f.log.filter((l) => l === "keys raaaaaaaa enter");

test("an unsubmitted prompt is nudged with enter after 5 s; working acknowledges it and stops nudges", async () => {
  const f = fakes({ start: "blocked" });
  await f.mgr.start(req("raaaaaaaa"));
  f.agents.get("raaaaaaaa")!.agentStatus = "idle";
  await poll(f);                                   // deferred prompt sent
  let s = await poll(f, 5000);                     // still idle: the Enter was lost
  expect(nudges(f)).toHaveLength(1);
  expect(s.promptSent).toBe(false);
  expect(f.state.load("raaaaaaaa")).toMatchObject({ nudgeCount: 1, lastNudgeAt: 1_005_000 });
  f.agents.get("raaaaaaaa")!.agentStatus = "working";
  s = await poll(f, 1000);
  expect(s.promptSent).toBe(true);
  expect(f.state.load("raaaaaaaa")?.promptAcked).toBe(true);
  f.agents.get("raaaaaaaa")!.agentStatus = "idle";
  await poll(f, 60_000);
  expect(nudges(f)).toHaveLength(1);
});

test("no nudge before 5 s have passed since the prompt, nor between nudges", async () => {
  const f = fakes({ start: "blocked" });
  await f.mgr.start(req("raaaaaaaa"));
  f.agents.get("raaaaaaaa")!.agentStatus = "idle";
  await poll(f);
  await poll(f, 4999);
  expect(nudges(f)).toHaveLength(0);
  await poll(f, 1);
  expect(nudges(f)).toHaveLength(1);
  await poll(f, 4999);
  expect(nudges(f)).toHaveLength(1);
  await poll(f, 1);
  expect(nudges(f)).toHaveLength(2);
});

test("at most 3 nudges, then the prompt is reported as sent so the idle timer applies", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));             // launch sent the prompt; agent stays idle
  for (let i = 1; i <= 3; i++) {
    expect((await poll(f, 5000)).promptSent).toBe(false);
    expect(nudges(f)).toHaveLength(i);
  }
  expect((await poll(f, 4999)).promptSent).toBe(false);   // the third nudge had no time to act yet
  expect((await poll(f, 1)).promptSent).toBe(true);
  expect(nudges(f)).toHaveLength(3);
  await poll(f, 60_000);
  expect(nudges(f)).toHaveLength(3);
});

test("a record from before acknowledgement existed, stuck on an idle agent, is nudged on the first status", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  const { promptSentAt: _a, promptAcked: _b, nudgeCount: _c, lastNudgeAt: _d, ...old } = f.state.load("raaaaaaaa")!;
  f.state.save(old as any);
  const s = await poll(f);
  expect(nudges(f)).toHaveLength(1);
  expect(s.promptSent).toBe(false);
});

test("progress or a PR acknowledges the prompt without ever seeing working", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  f.exec(() => ({ code: 0, stdout: JSON.stringify([{ url: "https://github.com/o/r/pull/1" }]), stderr: "" }));
  const s = await poll(f, 10_000);
  expect(s).toMatchObject({ prUrl: "https://github.com/o/r/pull/1", promptSent: true });
  expect(nudges(f)).toHaveLength(0);

  const g = fakes();
  const rec = await g.mgr.start(req("rbbbbbbbb"));
  const dir = mkdtempSync(join(tmpdir(), "tac-wt-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, rec.planPath), "## Wave\n### Task 1\n- [x] one\n- [ ] two\n");
  g.state.save({ ...rec, worktreePath: dir });
  const t = await g.mgr.status("rbbbbbbbb");
  expect(t.progress?.done).toBeGreaterThan(0);
  expect(t.promptSent).toBe(true);
  rmSync(dir, { recursive: true });
});

test("a blocked agent acknowledges the prompt and an agent_blocked nudge is ignored", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  (f.mgr as any).d.herdr.sendKeys = async () => { throw new HerdrError("agent_blocked", "blocked"); };
  await poll(f, 5000);                             // idle, nudge throws agent_blocked: ignored
  expect(f.state.load("raaaaaaaa")?.nudgeCount).toBe(1);
  f.agents.get("raaaaaaaa")!.agentStatus = "blocked";
  expect((await poll(f, 1000)).promptSent).toBe(true);
});
