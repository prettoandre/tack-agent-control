import { expect, test } from "bun:test";
import { parsePlanProgress } from "./plan";

const PLAN = `# Plan
## Global Constraints
- [ ] not a task checkbox
## Wave 1
### Task 1: A
- [x] **Step 1**
- [ ] **Step 2**
### Task 2: B
- [X] step
\`\`\`markdown
- [ ] example inside code, ignored
\`\`\`
## Wave 2
### Task 3: C
  - [ ] nested step
`;

test("groups checkboxes by wave and task", () => {
  const p = parsePlanProgress(PLAN);
  expect(p.total).toBe(4);
  expect(p.done).toBe(2);
  expect(p.waves.map((w) => w.title)).toEqual(["Wave 1", "Wave 2"]);
  expect(p.waves[0]!.tasks).toEqual([
    { title: "Task 1: A", done: 1, total: 2 },
    { title: "Task 2: B", done: 1, total: 1 },
  ]);
});

test("tasks before any wave heading go to an unnamed wave", () => {
  const p = parsePlanProgress("### Task 1: X\n- [ ] a\n");
  expect(p.waves).toEqual([{ title: "", tasks: [{ title: "Task 1: X", done: 0, total: 1 }] }]);
});

test("empty input", () => {
  expect(parsePlanProgress("")).toEqual({ waves: [], done: 0, total: 0 });
});
