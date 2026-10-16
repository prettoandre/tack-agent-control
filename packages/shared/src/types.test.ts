import { expect, test } from "bun:test";
import { ACTIVE_STATES, RUN_STATES, TERMINAL_STATES } from "./index";

test("state lists are consistent", () => {
  expect(RUN_STATES).toHaveLength(10);
  for (const s of [...TERMINAL_STATES, ...ACTIVE_STATES]) expect(RUN_STATES).toContain(s);
  for (const s of TERMINAL_STATES) expect(ACTIVE_STATES).not.toContain(s);
});
