import { expect, test } from "bun:test";
import { branchName, newRunId, planSlug } from "./ids";

test("run ids are herdr-safe and unique", () => {
  const ids = new Set(Array.from({ length: 500 }, newRunId));
  expect(ids.size).toBe(500);
  for (const id of ids) expect(id).toMatch(/^r[a-z0-9]{8}$/);
});

test("plan slug drops the directory, date and extension", () => {
  expect(planSlug("docs/superpowers/plans/2026-10-15-dispatcher-runner.md")).toBe("dispatcher-runner");
  expect(planSlug("plans/My Plan!.md")).toBe("my-plan");
});

test("branch name joins run id and slug and stays short", () => {
  expect(branchName("rabc12345", "docs/plans/2026-01-01-x.md")).toBe("run/rabc12345-x");
  expect(branchName("rabc12345", `p/${"a".repeat(200)}.md`).length).toBeLessThanOrEqual(64);
});
