import { expect, test } from "bun:test";
import { assertTransition, canTransition } from "./state";

test("happy path is allowed", () => {
  const path = ["queued", "preparing", "running", "waiting_input", "running", "finishing", "succeeded"] as const;
  for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
});

test("terminal states never move", () => {
  for (const to of ["running", "queued", "unknown"] as const) {
    expect(canTransition("succeeded", to)).toBe(false);
    expect(canTransition("failed", to)).toBe(false);
    expect(canTransition("cancelled", to)).toBe(false);
  }
});

test("any active state can become unknown, and unknown can come back", () => {
  for (const s of ["preparing", "running", "waiting_input", "finishing", "needs_attention"] as const) {
    expect(canTransition(s, "unknown")).toBe(true);
    expect(canTransition("unknown", s)).toBe(true);
  }
});

test("queued cannot skip to running", () => {
  expect(canTransition("queued", "running")).toBe(false);
  expect(() => assertTransition("queued", "running")).toThrow("invalid transition queued -> running");
});

test("needs_attention recovers when the agent works again or a PR shows up", () => {
  expect(canTransition("needs_attention", "running")).toBe(true);
  expect(canTransition("needs_attention", "succeeded")).toBe(true);
});

test("preparing can go straight to finishing or succeeded (prompt sent at start, first poll sees idle)", () => {
  expect(canTransition("preparing", "finishing")).toBe(true);
  expect(canTransition("preparing", "succeeded")).toBe(true);
});
