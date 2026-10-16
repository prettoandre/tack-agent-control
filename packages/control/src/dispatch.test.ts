import { expect, test } from "bun:test";
import { DispatchError, buildPrompt, dispatch } from "./dispatch";
import { Store } from "./store";

const projects = new Map([["proj", { name: "proj", host: "h1", repoPath: "/r", baseBranch: "main", agent: "claude" as const, agentArgs: [] }]]);
const hosts = new Map([["h1", { name: "h1", url: "http://x", token: "t", maxRuns: 2 }]]);
const client = (exists: boolean) => () => ({ checkPlan: async () => exists } as any);

test("dispatch inserts a queued run after the plan check", async () => {
  const store = new Store(":memory:");
  const r = await dispatch({ store, projects, hosts, client: client(true), now: () => 5 }, { project: "proj", planPath: "docs/plans/2026-01-01-x.md" });
  expect(r.state).toBe("queued");
  expect(r.branch).toBe(`run/${r.id}-x`);
  expect(store.events(r.id)[0]?.kind).toBe("dispatch");
});

test("plan not on origin: error and no row", async () => {
  const store = new Store(":memory:");
  const e = await dispatch({ store, projects, hosts, client: client(false), now: () => 5 }, { project: "proj", planPath: "x.md" }).catch((x) => x);
  expect(e).toBeInstanceOf(DispatchError);
  expect(e.code).toBe("plan_not_found");
  expect(store.listRuns()).toEqual([]);
});

test("unknown project or host", async () => {
  const deps = { store: new Store(":memory:"), projects, hosts, client: client(true), now: () => 5 };
  expect((await dispatch(deps, { project: "nope", planPath: "x.md" }).catch((x) => x)).code).toBe("unknown_project");
  expect((await dispatch(deps, { project: "proj", planPath: "x.md", host: "h9" }).catch((x) => x)).code).toBe("unknown_host");
});

test("prompt names the plan and the skill", () => {
  expect(buildPrompt("docs/p.md")).toContain("docs/p.md");
  expect(buildPrompt("docs/p.md")).toContain("superpowers:subagent-driven-development");
});

test("prompt asks the agent to tick the plan checkboxes and commit the plan file", () => {
  expect(buildPrompt("docs/p.md")).toBe(
    "Execute the plan at docs/p.md using the superpowers:subagent-driven-development skill. " +
    "When all tasks are done, open a pull request from the current branch. " +
    'As you complete each step, mark its checkbox in the plan file as done (change "- [ ]" to "- [x]") ' +
    "and commit the plan file with your work.",
  );
});
