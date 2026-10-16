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
  expect(state.load("raaaaaaaa")).toMatchObject({ promptSent: true, promptSentAt: 1_000_000, promptAcked: false, promptAttempts: 1 });
});

test("a new RunManager over the same state dir reports the same run (runner restart)", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  await f.mgr.status("raaaaaaaa");   // prompt sent
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

  // herdr already lists the agent as idle while the launch is still in flight: no prompt yet
  f.agents.set("raaaaaaaa", { agentStatus: "idle", paneId: rec.paneId, tabId: rec.tabId });
  s = await f.mgr.status("raaaaaaaa");
  expect(s.promptSent).toBe(false);
  expect(f.log.some((l) => l.startsWith("prompt"))).toBe(false);

  release();
  await launched;
  expect(f.log.some((l) => l.startsWith("prompt"))).toBe(false);   // launch never prompts
  s = await f.mgr.status("raaaaaaaa");                              // the first idle poll does
  expect(f.log.filter((l) => l.startsWith("prompt"))).toEqual(["prompt raaaaaaaa execute docs/p.md"]);
  expect(s.agentStatus).toBe("working");
  expect(f.state.load("raaaaaaaa")?.promptSent).toBe(true);
});

const RULE = "─".repeat(100);
/** A Claude Code screen: transcript lines, then the input box between two rules, then the footer. */
const claudeScreen = (input: string, transcript: string[] = []) =>
  [" ▐▛███▛█   Claude Code v2.1.301", ...transcript, RULE, `❯ ${input}`, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
const PROMPT = "execute docs/p.md";

const poll = async (f: ReturnType<typeof fakes>, advanceMs = 0) => { f.clock.now += advanceMs; return f.mgr.status("raaaaaaaa"); };
const enters = (f: ReturnType<typeof fakes>) => f.log.filter((l) => l === "keys raaaaaaaa enter");
const prompts = (f: ReturnType<typeof fakes>) => f.log.filter((l) => l === `prompt raaaaaaaa ${PROMPT}`);
/** A started run whose first prompt went out on the first idle poll. */
async function sent(opts: Parameters<typeof fakes>[0] = {}) {
  const f = fakes(opts);
  await f.mgr.start(req("raaaaaaaa"));
  await poll(f);
  expect(prompts(f)).toHaveLength(1);
  return f;
}

test("prompt typed but not submitted (visible in the input box): the retry presses enter", async () => {
  const f = await sent();
  f.screen.text = claudeScreen(PROMPT);
  const s = await poll(f, 4000);
  expect(enters(f)).toHaveLength(1);
  expect(prompts(f)).toHaveLength(1);
  expect(s.promptSent).toBe(false);
  expect(f.state.load("raaaaaaaa")).toMatchObject({ promptAttempts: 2, lastPromptAttemptAt: 1_004_000 });
});

test("prompt text dropped (not on screen): the retry sends the prompt again and never presses enter", async () => {
  const f = await sent();
  f.screen.text = claudeScreen("");
  await poll(f, 4000);
  expect(prompts(f)).toHaveLength(2);
  expect(enters(f)).toHaveLength(0);
});

test("a dialog on screen without the prompt text never gets an enter", async () => {
  const f = await sent();
  f.screen.text = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\nEnter to confirm";
  await poll(f, 4000);
  expect(enters(f)).toHaveLength(0);
});

test("prompt already submitted (only in the transcript) acknowledges delivery without keys or a resend", async () => {
  const f = await sent();
  f.screen.text = claudeScreen("delete the remote branch", [`❯ ${PROMPT}`, "● Done."]);
  const s = await poll(f, 4000);
  expect(enters(f)).toHaveLength(0);
  expect(prompts(f)).toHaveLength(1);
  expect(s.promptSent).toBe(true);
  expect(f.state.load("raaaaaaaa")?.promptAcked).toBe(true);
});

test("the prompt is matched by its first 40 characters, whitespace-normalized, across wrapped lines", async () => {
  const long = "Execute the plan at docs/superpowers/plans/2026-10-15-hello.md using the skill.";
  const f = fakes();
  await f.mgr.start({ ...req("raaaaaaaa"), prompt: long });
  await poll(f);
  f.screen.text = [RULE, "❯ Execute the plan at docs/superpowers/", "  plans/2026-10-15-hello.md using the skill.", RULE].join("\n");
  await poll(f, 4000);
  expect(enters(f)).toHaveLength(1);
});

test("without an input box on screen, prompt text anywhere means unsubmitted", async () => {
  const f = await sent();
  f.screen.text = `› ${PROMPT}`;
  await poll(f, 4000);
  expect(enters(f)).toHaveLength(1);
});

test("retries wait 4 s after the previous attempt", async () => {
  const f = await sent();
  f.screen.text = claudeScreen("");
  await poll(f, 3999);
  expect(prompts(f)).toHaveLength(1);
  await poll(f, 1);
  expect(prompts(f)).toHaveLength(2);
  await poll(f, 3999);
  expect(prompts(f)).toHaveLength(2);
  await poll(f, 1);
  expect(prompts(f)).toHaveLength(3);
});

test("at most 3 attempts in total, then the prompt is reported as sent so the idle timer applies", async () => {
  const f = await sent();
  f.screen.text = claudeScreen(PROMPT);
  expect((await poll(f, 4000)).promptSent).toBe(false);
  expect((await poll(f, 4000)).promptSent).toBe(false);
  expect(enters(f)).toHaveLength(2);
  expect((await poll(f, 3999)).promptSent).toBe(false);   // the last attempt had no time to act yet
  expect((await poll(f, 1)).promptSent).toBe(true);
  await poll(f, 60_000);
  expect(enters(f)).toHaveLength(2);
  expect(prompts(f)).toHaveLength(1);
  expect(f.state.load("raaaaaaaa")?.promptAttempts).toBe(3);
});

test("working acknowledges the prompt and stops the retries", async () => {
  const f = await sent();
  f.agents.get("raaaaaaaa")!.agentStatus = "working";
  expect((await poll(f, 1000)).promptSent).toBe(true);
  expect(f.state.load("raaaaaaaa")?.promptAcked).toBe(true);
  f.agents.get("raaaaaaaa")!.agentStatus = "idle";
  f.screen.text = claudeScreen(PROMPT);
  await poll(f, 60_000);
  expect(enters(f)).toHaveLength(0);
  expect(prompts(f)).toHaveLength(1);
});

test("a blocked agent acknowledges the prompt", async () => {
  const f = await sent();
  f.agents.get("raaaaaaaa")!.agentStatus = "blocked";
  expect((await poll(f, 1000)).promptSent).toBe(true);
});

const PR1 = "https://github.com/o/r/pull/1";
const PR2 = "https://github.com/o/r/pull/2";

test("a PR or ticked boxes that already existed when the prompt went out do not acknowledge it (retry case)", async () => {
  const f = fakes();
  const rec = await f.mgr.start(req("raaaaaaaa"));
  const dir = mkdtempSync(join(tmpdir(), "tac-wt-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, rec.planPath), "## Wave\n### Task 1\n- [x] one\n- [ ] two\n");
  f.state.save({ ...f.state.load("raaaaaaaa")!, worktreePath: dir });
  f.exec(() => ({ code: 0, stdout: JSON.stringify([{ url: PR1 }]), stderr: "" }));
  await poll(f);                                     // prompt sent; baseline: PR1, 1 done
  expect(f.state.load("raaaaaaaa")?.promptBaseline).toEqual({ prUrl: PR1, done: 1, headSha: "a".repeat(40) });
  f.screen.text = claudeScreen(PROMPT);
  const s = await poll(f, 4000);
  expect(s.promptSent).toBe(false);
  expect(enters(f)).toHaveLength(1);
  rmSync(dir, { recursive: true });
});

test("a new PR acknowledges the prompt", async () => {
  const f = await sent();
  f.exec(() => ({ code: 0, stdout: JSON.stringify([{ url: PR2 }]), stderr: "" }));
  expect((await poll(f, 1000)).promptSent).toBe(true);
});

test("more ticked boxes than at send time acknowledge the prompt", async () => {
  const f = fakes();
  const rec = await f.mgr.start(req("raaaaaaaa"));
  const dir = mkdtempSync(join(tmpdir(), "tac-wt-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, rec.planPath), "## Wave\n### Task 1\n- [ ] one\n- [ ] two\n");
  f.state.save({ ...f.state.load("raaaaaaaa")!, worktreePath: dir });
  await poll(f);
  writeFileSync(join(dir, rec.planPath), "## Wave\n### Task 1\n- [x] one\n- [ ] two\n");
  expect((await poll(f, 1000)).promptSent).toBe(true);
  rmSync(dir, { recursive: true });
});

test("a new commit on the run branch acknowledges the prompt", async () => {
  const f = await sent();
  (f.mgr as any).d.git.headSha = async () => "b".repeat(40);
  expect((await poll(f, 1000)).promptSent).toBe(true);
});

test("agent_blocked from an attempt does not count as an attempt", async () => {
  const f = await sent();
  f.screen.text = claudeScreen(PROMPT);
  (f.mgr as any).d.herdr.sendKeys = async () => { throw new HerdrError("agent_blocked", "blocked"); };
  await poll(f, 4000);
  expect(f.state.load("raaaaaaaa")).toMatchObject({ promptAttempts: 1, lastPromptAttemptAt: 1_000_000 });
});

test("agent_blocked on the first send leaves the prompt unsent", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  (f.mgr as any).d.herdr.prompt = async () => { throw new HerdrError("agent_blocked", "blocked"); };
  const s = await poll(f);
  expect(s.promptSent).toBe(false);
  expect(f.state.load("raaaaaaaa")).toMatchObject({ promptSent: false, promptAttempts: 0 });
});

test("a failing retry does not make status fail and still counts as an attempt", async () => {
  const f = await sent();
  f.screen.text = claudeScreen(PROMPT);
  (f.mgr as any).d.herdr.sendKeys = async () => { throw new HerdrError("exit_1", "herdr crashed"); };
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const s = await poll(f, 4000);
    expect(s.known).toBe(true);
  } finally { console.error = realError; }
  expect(f.state.load("raaaaaaaa")?.promptAttempts).toBe(2);
  expect(logged.some((l) => l.includes("herdr crashed"))).toBe(true);
});

test("a failing first send does not make status fail and counts as an attempt", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  (f.mgr as any).d.herdr.prompt = async () => { throw new HerdrError("exit_1", "herdr crashed"); };
  const realError = console.error;
  console.error = () => {};
  try {
    expect((await poll(f)).known).toBe(true);
  } finally { console.error = realError; }
  expect(f.state.load("raaaaaaaa")).toMatchObject({ promptSent: true, promptAttempts: 1 });
});

test("a status poll racing with cleanup does not resurrect the state file or prompt", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  f.exec(() => { f.state.remove("raaaaaaaa"); return { code: 0, stdout: "[]", stderr: "" }; });   // cleanup lands mid-poll
  await poll(f);
  expect(f.state.load("raaaaaaaa")).toBeNull();
  expect(prompts(f)).toHaveLength(0);
});

test("a record from before delivery tracking, stuck on an idle agent, is retried on the first status", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
  const { promptSentAt: _a, promptAcked: _b, promptAttempts: _c, lastPromptAttemptAt: _d, promptBaseline: _e, ...old } = f.state.load("raaaaaaaa")!;
  f.state.save({ ...old, promptSent: true, nudgeCount: 0, lastNudgeAt: null } as any);
  f.screen.text = claudeScreen(PROMPT);
  const s = await poll(f);
  expect(enters(f)).toHaveLength(1);
  expect(s.promptSent).toBe(false);
});
