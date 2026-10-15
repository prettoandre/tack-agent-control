import { expect, test } from "bun:test";
import { RunManager } from "./runs";
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
  expect(s.promptSent).toBe(true);
  expect(s.agentStatus).toBe("working");
  expect(state.load("raaaaaaaa")?.promptSent).toBe(true);
});

test("a new RunManager over the same state dir reports the same run (runner restart)", async () => {
  const f = fakes();
  await f.mgr.start(req("raaaaaaaa"));
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
