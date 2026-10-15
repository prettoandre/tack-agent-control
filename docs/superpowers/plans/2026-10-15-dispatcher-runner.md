# tack-agent-control Dispatcher and Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build sub-project 2 of the spec: the `control` service, the per-devbox `runner`, the `tac` CLI and a minimal run list plus live terminal view, so a pushed superpowers plan can be dispatched from the Mac and run interactively in herdr on a devbox.

**Architecture:** A Bun monorepo with four packages. `shared` holds types, the run state machine and the plan progress parser. `runner` wraps the herdr CLI and git on a devbox behind a small token-protected HTTP API. `control` owns SQLite state, dispatches queued runs to runners, reconciles their status every few seconds and serves the API, a terminal WebSocket and a minimal React UI. `cli` is a thin `tac` client of the control API.

**Tech Stack:** Bun 1.2+ (runtime, test runner, bundler, `bun:sqlite`), TypeScript 5 (strict), Hono 4, zod 3, yaml 2, React 18, @xterm/xterm 5, herdr 0.9.3, git, gh.

**Spec:** `docs/superpowers/specs/2026-10-15-tack-agent-control-design.md`

**Out of this plan:** sub-project 1 (VM, Tailscale, Ansible) gets its own plan in `~/workspace/infra` after this one. Until then `control` runs locally on the Mac or on devbox-homelab, and the runner is started by hand.

## Global Constraints

- Single user; access only over the tailnet. Identity comes from the Tailscale Serve header `Tailscale-User-Login`; only logins in `TAC_ALLOWED_LOGINS` pass.
- Runner listens only on the address in `TAC_RUNNER_LISTEN` (the tailnet IP in production) and requires `Authorization: Bearer <TAC_RUNNER_TOKEN>` on every route except `GET /health`.
- Runner exposes only closed operations; it never executes a command string received from `control`.
- Runs never use `bypassPermissions` or `--dangerously-bypass-approvals-and-sandbox`.
- The system never trusts an agent's own report: state and results come only from herdr agent state, commits, plan checkboxes and an existing PR.
- Run states are exactly: `queued`, `preparing`, `running`, `waiting_input`, `finishing`, `succeeded`, `needs_attention`, `failed`, `cancelled`, `unknown`.
- Worktree path: `~/worktrees/<project>/<runId>`; branch: `run/<runId>-<plan-slug>`.
- Defaults: 2 concurrent runs per host; idle timeout 15 minutes; runner health check every 15 s, host `unreachable` after 3 consecutive failures; reconcile loop every 5 s.
- Every input sent through `control` is recorded in `run_events` with time and source.
- No project secret passes through `control`.
- Code, comments and commit messages in English.

## Review Focus

1. A plan path that is not on `origin/<base>` (typo, not pushed): `tac dispatch` fails at once with `plan_not_found` and no run row is left behind. Test: Task 10.
2. The runner restarts while a run is active: the run is rebuilt from its state file and herdr, and is not marked `failed`. Test: Task 8.
3. Two runs of the same project at the same time: distinct run IDs, worktrees and branches; neither touches the other. Test: Task 7.
4. The agent is blocked at startup (Claude Code's folder trust dialog): the run shows `waiting_input`, and the initial prompt is sent only after the agent first becomes idle. Test: Task 8.
5. User input that herdr rejects (agent busy or blocked for `prompt`): the error reaches the caller with herdr's code, and the attempt is still recorded in `run_events`. Test: Task 12.

---

## File Structure

```
package.json                 # bun workspaces, scripts
tsconfig.base.json
bunfig.toml
packages/shared/src/types.ts        # Run, RunState, RunEvent, RunnerRunStatus, PlanProgress, DTOs
packages/shared/src/state.ts        # transition rules
packages/shared/src/plan.ts         # parsePlanProgress
packages/shared/src/ids.ts          # newRunId, planSlug, branchName
packages/shared/src/index.ts
packages/runner/src/exec.ts         # Exec type + real Bun.spawn implementation
packages/runner/src/herdr.ts        # typed herdr CLI client
packages/runner/src/git.ts          # fetch, plan check, worktree add/remove, head sha
packages/runner/src/statefile.ts    # per-run state files under ~/.local/state/tac-runner
packages/runner/src/runs.ts         # RunManager: prepare, status, input, cancel, cleanup
packages/runner/src/server.ts       # Hono app + auth
packages/runner/src/main.ts         # entrypoint
packages/control/src/config.ts     # projects.yaml + hosts.yaml loading (zod)
packages/control/src/store.ts      # SQLite schema and queries
packages/control/src/runner-client.ts
packages/control/src/decide.ts     # runner status -> next run state
packages/control/src/loop.ts       # dispatch, reconcile, health
packages/control/src/server.ts     # API, auth, terminal WS, static UI
packages/control/src/main.ts
packages/control/ui/index.html
packages/control/ui/main.tsx       # run list + terminal view
packages/cli/src/tac.ts            # tac CLI
docs/operations.md                 # how to run control and runner by hand, e2e
```

Tests live next to sources as `*.test.ts`.

---

### Task 1: Monorepo scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `bunfig.toml`, `.gitignore`
- Create: `packages/{shared,runner,control,cli}/package.json`, `packages/*/tsconfig.json`
- Create: `packages/shared/src/types.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/types.test.ts`

**Interfaces:**
- Produces: package names `@tac/shared`, `@tac/runner`, `@tac/control`, `@tac/cli`; all types below, exported from `@tac/shared`.

- [ ] **Step 1: Create the root files**

`package.json`:
```json
{
  "name": "tack-agent-control",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -p packages/shared && tsc -p packages/runner && tsc -p packages/control && tsc -p packages/cli"
  },
  "devDependencies": { "typescript": "^5.6.0", "@types/bun": "latest" }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "types": ["bun"], "jsx": "react-jsx", "lib": ["ES2022", "DOM"]
  }
}
```

`bunfig.toml`:
```toml
[test]
timeout = 20000
```

`.gitignore`:
```
node_modules/
dist/
*.sqlite
.env
```

Each `packages/<name>/package.json` (replace `<name>`; `runner` and `control` and `cli` depend on `@tac/shared`):
```json
{ "name": "@tac/<name>", "private": true, "type": "module", "main": "src/index.ts",
  "dependencies": { "@tac/shared": "workspace:*" } }
```
For `shared` omit `dependencies`. Each `packages/<name>/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "ui"] }
```

- [ ] **Step 2: Write the shared types**

`packages/shared/src/types.ts`:
```ts
export const RUN_STATES = [
  "queued", "preparing", "running", "waiting_input", "finishing",
  "succeeded", "needs_attention", "failed", "cancelled", "unknown",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];
export const ACTIVE_STATES: readonly RunState[] = [
  "preparing", "running", "waiting_input", "finishing", "needs_attention", "unknown",
];

export type AgentKind = "claude" | "codex";
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface TaskProgress { title: string; done: number; total: number }
export interface WaveProgress { title: string; tasks: TaskProgress[] }
export interface PlanProgress { waves: WaveProgress[]; done: number; total: number }

export interface Run {
  id: string;
  project: string;
  host: string;
  agent: AgentKind;
  planPath: string;
  baseBranch: string;
  branch: string;
  state: RunState;
  prUrl: string | null;
  progress: PlanProgress | null;
  idleSince: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type RunEventKind = "state" | "input" | "progress" | "error" | "dispatch";
export type RunEventSource = "control" | "runner" | "user";
export interface RunEvent {
  runId: string;
  at: number;
  kind: RunEventKind;
  source: RunEventSource;
  data: Record<string, unknown>;
}

/** What a runner reports about one run. Facts only, no decisions. */
export interface RunnerRunStatus {
  runId: string;
  known: boolean;          // runner has a state file for this run
  agentPresent: boolean;   // herdr still sees the named agent
  agentStatus: HerdrAgentStatus | null;
  promptSent: boolean;     // the initial prompt was submitted
  progress: PlanProgress | null;
  prUrl: string | null;
  headSha: string | null;
}

/** Body of POST /runs on the runner. */
export interface RunnerStartRequest {
  runId: string;
  project: string;
  repoPath: string;      // existing clone on the devbox
  baseBranch: string;
  planPath: string;
  branch: string;
  agent: AgentKind;
  agentArgs: string[];
  prompt: string;
}

export type RunnerInput =
  | { type: "prompt"; text: string }
  | { type: "keys"; keys: string[] }
  | { type: "text"; text: string };

export interface ApiError { error: { code: string; message: string } }
```

`packages/shared/src/index.ts`:
```ts
export * from "./types";
```

- [ ] **Step 3: Write a smoke test**

`packages/shared/src/types.test.ts`:
```ts
import { expect, test } from "bun:test";
import { ACTIVE_STATES, RUN_STATES, TERMINAL_STATES } from "./index";

test("state lists are consistent", () => {
  expect(RUN_STATES).toHaveLength(10);
  for (const s of [...TERMINAL_STATES, ...ACTIVE_STATES]) expect(RUN_STATES).toContain(s);
  for (const s of TERMINAL_STATES) expect(ACTIVE_STATES).not.toContain(s);
});
```

- [ ] **Step 4: Install and run**

Run: `bun install && bun test packages/shared && bun run typecheck`
Expected: 1 test passes; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold bun monorepo with shared types"
```

---

### Task 2: Run state machine and IDs

**Files:**
- Create: `packages/shared/src/state.ts`, `packages/shared/src/ids.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/state.test.ts`, `packages/shared/src/ids.test.ts`

**Interfaces:**
- Consumes: `RunState`, `TERMINAL_STATES` from Task 1.
- Produces: `canTransition(from: RunState, to: RunState): boolean`; `assertTransition(from, to): void` (throws `Error("invalid transition <from> -> <to>")`); `newRunId(): string` (matches `/^r[a-z0-9]{8}$/`, valid herdr agent name); `planSlug(planPath: string): string`; `branchName(runId: string, planPath: string): string`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/state.test.ts`:
```ts
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
```

`packages/shared/src/ids.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/shared`
Expected: FAIL, cannot find module `./state` / `./ids`.

- [ ] **Step 3: Implement**

`packages/shared/src/state.ts`:
```ts
import type { RunState } from "./types";

const ALLOWED: Record<RunState, readonly RunState[]> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["running", "waiting_input", "failed", "cancelled", "unknown"],
  running: ["waiting_input", "finishing", "succeeded", "failed", "cancelled", "unknown"],
  waiting_input: ["running", "finishing", "succeeded", "failed", "cancelled", "unknown"],
  finishing: ["running", "waiting_input", "succeeded", "needs_attention", "failed", "cancelled", "unknown"],
  needs_attention: ["running", "waiting_input", "succeeded", "failed", "cancelled", "unknown"],
  unknown: ["preparing", "running", "waiting_input", "finishing", "needs_attention", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new Error(`invalid transition ${from} -> ${to}`);
}
```

`packages/shared/src/ids.ts`:
```ts
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "r";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function planSlug(planPath: string): string {
  const base = planPath.split("/").pop() ?? planPath;
  return base
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function branchName(runId: string, planPath: string): string {
  return `run/${runId}-${planSlug(planPath)}`.slice(0, 64).replace(/-+$/, "");
}
```

Add to `packages/shared/src/index.ts`:
```ts
export * from "./state";
export * from "./ids";
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/shared`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shared): run state machine and run ids"
```

---

### Task 3: Plan progress parser

**Files:**
- Create: `packages/shared/src/plan.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/plan.test.ts`

**Interfaces:**
- Consumes: `PlanProgress`, `WaveProgress`, `TaskProgress` from Task 1.
- Produces: `parsePlanProgress(markdown: string): PlanProgress`.

Rules: a `## ` heading opens a wave; a `### ` heading opens a task inside the current wave (a wave titled `""` when no `## ` heading came first); each line matching `^\s*- \[( |x|X)\] ` inside a task counts toward that task. Checkboxes outside any task are ignored. Waves with no tasks are dropped. Lines inside fenced code blocks (```` ``` ````) are ignored, because plans contain example checkboxes in code.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/plan.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/shared/src/plan.test.ts`
Expected: FAIL, cannot find module `./plan`.

- [ ] **Step 3: Implement**

`packages/shared/src/plan.ts`:
```ts
import type { PlanProgress, TaskProgress, WaveProgress } from "./types";

const BOX = /^\s*- \[( |x|X)\] /;

export function parsePlanProgress(markdown: string): PlanProgress {
  const waves: WaveProgress[] = [];
  let wave: WaveProgress | null = null;
  let task: TaskProgress | null = null;
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.startsWith("## ")) {
      wave = { title: line.slice(3).trim(), tasks: [] };
      waves.push(wave);
      task = null;
      continue;
    }
    if (line.startsWith("### ")) {
      if (!wave) { wave = { title: "", tasks: [] }; waves.push(wave); }
      task = { title: line.slice(4).trim(), done: 0, total: 0 };
      wave.tasks.push(task);
      continue;
    }
    const m = BOX.exec(line);
    if (m && task) {
      task.total += 1;
      if (m[1] !== " ") task.done += 1;
    }
  }

  const kept = waves.filter((w) => w.tasks.length > 0);
  let done = 0, total = 0;
  for (const w of kept) for (const t of w.tasks) { done += t.done; total += t.total; }
  return { waves: kept, done, total };
}
```

Add `export * from "./plan";` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/shared`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shared): plan progress parser"
```

---

### Task 4: herdr CLI client

**Files:**
- Create: `packages/runner/src/exec.ts`, `packages/runner/src/herdr.ts`
- Test: `packages/runner/src/herdr.test.ts`

**Interfaces:**
- Consumes: `AgentKind`, `HerdrAgentStatus` from `@tac/shared`.
- Produces:
  - `type Exec = (cmd: string[], opts?: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>`; `realExec: Exec`.
  - `class HerdrError extends Error { code: string }`.
  - `interface HerdrAgent { name: string; agentStatus: HerdrAgentStatus; paneId: string; tabId: string; workspaceId: string; cwd: string; launchPending: boolean }`.
  - `class Herdr` with constructor `(exec: Exec, bin = "herdr", session?: string)` and methods:
    `listWorkspaces(): Promise<{ workspaceId: string; label: string }[]>`,
    `createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }>`,
    `createTab(workspaceId: string, cwd: string, label: string): Promise<{ tabId: string; paneId: string }>`,
    `closeTab(tabId: string): Promise<void>`,
    `startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<"ready" | "blocked">`,
    `getAgent(name: string): Promise<HerdrAgent | null>`,
    `listAgents(): Promise<HerdrAgent[]>`,
    `prompt(name: string, text: string): Promise<void>`,
    `sendKeys(name: string, keys: string[]): Promise<void>`,
    `sendText(paneId: string, text: string): Promise<void>`,
    `readPane(paneId: string, lines: number, format: "text" | "ansi"): Promise<string>`.

Facts verified against herdr 0.9.3 on devbox-homelab (2026-10-15):
- Control commands print JSON on stdout: `{"id": "...", "result": {...}}`. Server errors print `{"error": {"code", "message"}}` on stderr (observed also on stdout for some commands) with exit 1. Syntax errors exit 2.
- `workspace create --cwd <p> --label <l>` → `result.workspace.workspace_id`, `result.root_pane.pane_id`.
- `tab create --workspace <id> --cwd <p> --label <l>` → `result.tab.tab_id`, `result.root_pane.pane_id`.
- `agent start <name> --kind <k> --pane <id> [-- args]` → error code `agent_not_ready` when the agent is blocked at startup (for example Claude Code's folder trust dialog); the agent name stays usable.
- `agent get <name>` → `result.agent` with `agent_status`, `pane_id`, `tab_id`, `workspace_id`, `cwd`, `launch_pending`; error `agent_not_found` when the agent exited.
- `agent list` → `result.agents[]`, same objects.
- `agent prompt <name> <text>` → error `agent_blocked` when the agent waits for interactive input.
- `agent read` and `pane read` print plain text, not JSON.
- Global `--session <name>` selects a named server (used by tests).
- Not yet verified: the exact `workspace list` result key and `tab close` syntax. Step 1 checks them.

- [ ] **Step 1: Confirm the two unverified commands on devbox-homelab**

Run (on devbox-homelab, against a throwaway session):
```bash
H="herdr --session tac-verify"; ($H server >/tmp/tac-verify.log 2>&1 &); sleep 2
$H workspace create --cwd /tmp --label v; $H workspace list; $H tab create --workspace w1 --cwd /tmp --label t
herdr tab close --help; $H tab close w1:t2; herdr session stop tac-verify; herdr session delete tac-verify
```
Expected: `workspace list` prints `result.workspaces[]` with `workspace_id` and `label`; `tab close <tab_id>` succeeds. If either differs, use the observed shape in Step 3 and in the fakes of Step 2, and note it in the commit message.

- [ ] **Step 2: Write the failing test with a fake Exec**

`packages/runner/src/herdr.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { Exec } from "./exec";
import { Herdr, HerdrError } from "./herdr";

function fakeExec(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    const key = cmd.slice(1).filter((a) => !a.startsWith("--session")).join(" ");
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected command: ${key}`);
    return { code: hit[1].code ?? 0, stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "" };
  };
  return { exec, calls };
}

const AGENT = {
  agent: "claude", agent_status: "blocked", cwd: "/w", launch_pending: true, name: "rabc12345",
  pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1",
};

test("createWorkspace returns ids", async () => {
  const { exec } = fakeExec({
    "workspace create": { stdout: JSON.stringify({ id: "x", result: { workspace: { workspace_id: "w3" }, root_pane: { pane_id: "w3:p1" } } }) },
  });
  expect(await new Herdr(exec).createWorkspace("/w", "tac:proj")).toEqual({ workspaceId: "w3", paneId: "w3:p1" });
});

test("startAgent maps agent_not_ready to blocked and passes args after --", async () => {
  const { exec, calls } = fakeExec({
    "agent start": { code: 1, stderr: JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } }) },
  });
  expect(await new Herdr(exec).startAgent("rabc12345", "claude", "w1:p2", ["--model", "haiku"])).toBe("blocked");
  expect(calls[0]).toEqual(["herdr", "agent", "start", "rabc12345", "--kind", "claude", "--pane", "w1:p2", "--timeout", "60000", "--", "--model", "haiku"]);
});

test("getAgent returns null when the agent is gone", async () => {
  const { exec } = fakeExec({
    "agent get": { code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found", message: "x" } }) },
  });
  expect(await new Herdr(exec).getAgent("rabc12345")).toBeNull();
});

test("getAgent maps fields", async () => {
  const { exec } = fakeExec({ "agent get": { stdout: JSON.stringify({ result: { agent: AGENT } }) } });
  expect(await new Herdr(exec).getAgent("rabc12345")).toEqual({
    name: "rabc12345", agentStatus: "blocked", paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/w", launchPending: true,
  });
});

test("prompt surfaces herdr error codes", async () => {
  const { exec } = fakeExec({
    "agent prompt": { code: 1, stderr: JSON.stringify({ error: { code: "agent_blocked", message: "needs input" } }) },
  });
  const err = await new Herdr(exec).prompt("rabc12345", "hi").catch((e) => e);
  expect(err).toBeInstanceOf(HerdrError);
  expect(err.code).toBe("agent_blocked");
});

test("readPane returns plain text", async () => {
  const { exec, calls } = fakeExec({ "pane read": { stdout: "hello\nworld\n" } });
  expect(await new Herdr(exec).readPane("w1:p2", 80, "ansi")).toBe("hello\nworld\n");
  expect(calls[0]).toEqual(["herdr", "pane", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "ansi"]);
});

test("session flag goes first", async () => {
  const { exec, calls } = fakeExec({ "agent list": { stdout: JSON.stringify({ result: { agents: [AGENT] } }) } });
  await new Herdr(exec, "herdr", "tac-test").listAgents();
  expect(calls[0]!.slice(0, 3)).toEqual(["herdr", "--session", "tac-test"]);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test packages/runner/src/herdr.test.ts`
Expected: FAIL, cannot find module `./herdr`.

- [ ] **Step 4: Implement**

`packages/runner/src/exec.ts`:
```ts
export type Exec = (
  cmd: string[],
  opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = async (cmd, opts) => {
  const p = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { code, stdout, stderr };
};
```

`packages/runner/src/herdr.ts`:
```ts
import type { AgentKind, HerdrAgentStatus } from "@tac/shared";
import type { Exec } from "./exec";

export class HerdrError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface HerdrAgent {
  name: string; agentStatus: HerdrAgentStatus; paneId: string; tabId: string;
  workspaceId: string; cwd: string; launchPending: boolean;
}

const STATUSES: readonly HerdrAgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function toAgent(a: any): HerdrAgent {
  const s = STATUSES.includes(a.agent_status) ? a.agent_status : "unknown";
  return {
    name: a.name, agentStatus: s, paneId: a.pane_id, tabId: a.tab_id,
    workspaceId: a.workspace_id, cwd: a.cwd, launchPending: Boolean(a.launch_pending),
  };
}

function parseError(text: string): { code: string; message: string } | null {
  try {
    const j = JSON.parse(text);
    if (j?.error?.code) return { code: j.error.code, message: j.error.message ?? "" };
  } catch {}
  return null;
}

export class Herdr {
  constructor(private exec: Exec, private bin = "herdr", private session?: string) {}

  private async raw(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const prefix = this.session ? [this.bin, "--session", this.session] : [this.bin];
    return this.exec([...prefix, ...args]);
  }

  private async json(args: string[]): Promise<any> {
    const r = await this.raw(args);
    if (r.code !== 0) {
      const e = parseError(r.stderr) ?? parseError(r.stdout);
      throw new HerdrError(e?.code ?? `exit_${r.code}`, e?.message ?? r.stderr.trim());
    }
    const j = JSON.parse(r.stdout);
    if (j.error) throw new HerdrError(j.error.code, j.error.message ?? "");
    return j.result;
  }

  private async text(args: string[]): Promise<string> {
    const r = await this.raw(args);
    if (r.code !== 0) {
      const e = parseError(r.stderr) ?? parseError(r.stdout);
      throw new HerdrError(e?.code ?? `exit_${r.code}`, e?.message ?? r.stderr.trim());
    }
    return r.stdout;
  }

  async listWorkspaces() {
    const r = await this.json(["workspace", "list"]);
    return (r.workspaces as any[]).map((w) => ({ workspaceId: w.workspace_id as string, label: w.label as string }));
  }

  async createWorkspace(cwd: string, label: string) {
    const r = await this.json(["workspace", "create", "--cwd", cwd, "--label", label]);
    return { workspaceId: r.workspace.workspace_id as string, paneId: r.root_pane.pane_id as string };
  }

  async createTab(workspaceId: string, cwd: string, label: string) {
    const r = await this.json(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label]);
    return { tabId: r.tab.tab_id as string, paneId: r.root_pane.pane_id as string };
  }

  async closeTab(tabId: string) {
    await this.json(["tab", "close", tabId]);
  }

  async startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<"ready" | "blocked"> {
    try {
      await this.json(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "60000", "--", ...args]);
      return "ready";
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_not_ready") return "blocked";
      throw e;
    }
  }

  async getAgent(name: string): Promise<HerdrAgent | null> {
    try {
      return toAgent((await this.json(["agent", "get", name])).agent);
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_not_found") return null;
      throw e;
    }
  }

  async listAgents(): Promise<HerdrAgent[]> {
    return ((await this.json(["agent", "list"])).agents as any[]).map(toAgent);
  }

  async prompt(name: string, text: string) {
    await this.json(["agent", "prompt", name, text]);
  }

  async sendKeys(name: string, keys: string[]) {
    await this.json(["agent", "send-keys", name, ...keys]);
  }

  async sendText(paneId: string, text: string) {
    await this.json(["pane", "send-text", paneId, text]);
  }

  async readPane(paneId: string, lines: number, format: "text" | "ansi") {
    return this.text(["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", format]);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test packages/runner && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(runner): typed herdr CLI client"
```

---

### Task 5: Git operations

**Files:**
- Create: `packages/runner/src/git.ts`
- Test: `packages/runner/src/git.test.ts`

**Interfaces:**
- Consumes: `Exec`, `realExec` from Task 4.
- Produces: `class Git` with constructor `(exec: Exec)` and methods:
  `fetch(repoPath: string): Promise<void>`,
  `planExists(repoPath: string, baseBranch: string, planPath: string): Promise<boolean>` (checks `origin/<base>:<planPath>` after fetch),
  `addWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch: string): Promise<void>` (creates the branch from `origin/<base>`; if the branch already exists, checks it out instead, so `retry` keeps committed work),
  `removeWorktree(repoPath: string, worktreePath: string): Promise<void>`,
  `headSha(worktreePath: string): Promise<string | null>`,
  `originUrl(repoPath: string): Promise<string>`;
  `class GitError extends Error { stderr: string }`.

- [ ] **Step 1: Write the failing test using real temp repos**

`packages/runner/src/git.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExec } from "./exec";
import { Git } from "./git";

let root: string, origin: string, clone: string;
const git = new Git(realExec);
const sh = async (cwd: string, ...cmd: string[]) => {
  const r = await realExec(cmd, { cwd });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tac-git-"));
  origin = join(root, "origin.git");
  clone = join(root, "clone");
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  await sh(root, "git", "clone", "-q", origin, clone);
  await sh(clone, "git", "config", "user.email", "t@t");
  await sh(clone, "git", "config", "user.name", "t");
  await Bun.write(join(clone, "docs/plans/p.md"), "### Task 1: x\n- [ ] a\n");
  await sh(clone, "git", "add", ".");
  await sh(clone, "git", "commit", "-q", "-m", "init");
  await sh(clone, "git", "push", "-q", "origin", "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("planExists sees only pushed files", async () => {
  await git.fetch(clone);
  expect(await git.planExists(clone, "main", "docs/plans/p.md")).toBe(true);
  expect(await git.planExists(clone, "main", "docs/plans/missing.md")).toBe(false);
  await Bun.write(join(clone, "docs/plans/local.md"), "x");
  await sh(clone, "git", "add", "."); await sh(clone, "git", "commit", "-q", "-m", "local only");
  expect(await git.planExists(clone, "main", "docs/plans/local.md")).toBe(false);
});

test("two worktrees of the same repo do not collide", async () => {
  const a = join(root, "wt/ra"), b = join(root, "wt/rb");
  await git.addWorktree(clone, a, "run/ra-p", "main");
  await git.addWorktree(clone, b, "run/rb-p", "main");
  expect(await sh(a, "git", "branch", "--show-current")).toBe("run/ra-p");
  expect(await sh(b, "git", "branch", "--show-current")).toBe("run/rb-p");
  expect(await git.headSha(a)).toMatch(/^[0-9a-f]{40}$/);
  await git.removeWorktree(clone, a);
  expect(existsSync(a)).toBe(false);
  expect(existsSync(b)).toBe(true);
});

test("re-adding an existing branch keeps its commits", async () => {
  const w = join(root, "wt/rc");
  await git.addWorktree(clone, w, "run/rc-p", "main");
  await Bun.write(join(w, "f.txt"), "work");
  await sh(w, "git", "add", "."); await sh(w, "git", "commit", "-q", "-m", "work");
  const sha = await git.headSha(w);
  await git.removeWorktree(clone, w);
  await git.addWorktree(clone, w, "run/rc-p", "main");
  expect(await git.headSha(w)).toBe(sha);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/src/git.test.ts`
Expected: FAIL, cannot find module `./git`.

- [ ] **Step 3: Implement**

`packages/runner/src/git.ts`:
```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Exec } from "./exec";

export class GitError extends Error {
  constructor(message: string, public stderr: string) { super(message); }
}

export class Git {
  constructor(private exec: Exec) {}

  private async run(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.exec(["git", ...args], { cwd });
  }

  private async ok(cwd: string, args: string[]): Promise<string> {
    const r = await this.run(cwd, args);
    if (r.code !== 0) throw new GitError(`git ${args.join(" ")} failed`, r.stderr);
    return r.stdout.trim();
  }

  async fetch(repoPath: string) { await this.ok(repoPath, ["fetch", "--quiet", "origin"]); }

  async planExists(repoPath: string, baseBranch: string, planPath: string) {
    const r = await this.run(repoPath, ["cat-file", "-e", `origin/${baseBranch}:${planPath}`]);
    return r.code === 0;
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch: string) {
    mkdirSync(dirname(worktreePath), { recursive: true });
    const exists = (await this.run(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    if (exists) await this.ok(repoPath, ["worktree", "add", worktreePath, branch]);
    else await this.ok(repoPath, ["worktree", "add", "-b", branch, worktreePath, `origin/${baseBranch}`]);
  }

  async removeWorktree(repoPath: string, worktreePath: string) {
    await this.ok(repoPath, ["worktree", "remove", "--force", worktreePath]);
  }

  async headSha(worktreePath: string) {
    const r = await this.run(worktreePath, ["rev-parse", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async originUrl(repoPath: string) { return this.ok(repoPath, ["remote", "get-url", "origin"]); }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner/src/git.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(runner): git worktree operations"
```

---

### Task 6: Runner state files

**Files:**
- Create: `packages/runner/src/statefile.ts`
- Test: `packages/runner/src/statefile.test.ts`

**Interfaces:**
- Consumes: `RunnerStartRequest` from `@tac/shared`.
- Produces:
  - `interface RunRecord extends RunnerStartRequest { worktreePath: string; workspaceId: string; tabId: string; paneId: string; promptSent: boolean; createdAt: number }`
  - `class StateDir` with constructor `(dir: string)` and methods `save(r: RunRecord): void` (atomic write via temp file + rename), `load(runId: string): RunRecord | null`, `list(): RunRecord[]`, `remove(runId: string): void`.

- [ ] **Step 1: Write the failing test**

`packages/runner/src/statefile.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDir, type RunRecord } from "./statefile";

const rec = (id: string): RunRecord => ({
  runId: id, project: "p", repoPath: "/r", baseBranch: "main", planPath: "a.md", branch: `run/${id}-a`,
  agent: "claude", agentArgs: [], prompt: "go", worktreePath: `/w/${id}`, workspaceId: "w1",
  tabId: "w1:t2", paneId: "w1:p2", promptSent: false, createdAt: 1,
});

test("save, load, list, remove", () => {
  const dir = mkdtempSync(join(tmpdir(), "tac-state-"));
  const s = new StateDir(dir);
  s.save(rec("raaaaaaaa")); s.save(rec("rbbbbbbbb"));
  expect(s.load("raaaaaaaa")?.branch).toBe("run/raaaaaaaa-a");
  expect(s.list().map((r) => r.runId).sort()).toEqual(["raaaaaaaa", "rbbbbbbbb"]);
  s.save({ ...rec("raaaaaaaa"), promptSent: true });
  expect(s.load("raaaaaaaa")?.promptSent).toBe(true);
  s.remove("raaaaaaaa");
  expect(s.load("raaaaaaaa")).toBeNull();
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("rejects ids that could escape the directory", () => {
  const s = new StateDir(mkdtempSync(join(tmpdir(), "tac-state-")));
  expect(() => s.load("../etc/passwd")).toThrow("invalid run id");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/src/statefile.test.ts`
Expected: FAIL, cannot find module `./statefile`.

- [ ] **Step 3: Implement**

`packages/runner/src/statefile.ts`:
```ts
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerStartRequest } from "@tac/shared";

export interface RunRecord extends RunnerStartRequest {
  worktreePath: string; workspaceId: string; tabId: string; paneId: string;
  promptSent: boolean; createdAt: number;
}

const ID = /^r[a-z0-9]{8}$/;

export class StateDir {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }

  private path(runId: string) {
    if (!ID.test(runId)) throw new Error("invalid run id");
    return join(this.dir, `${runId}.json`);
  }

  save(r: RunRecord) {
    const p = this.path(r.runId);
    writeFileSync(`${p}.tmp`, JSON.stringify(r, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  load(runId: string): RunRecord | null {
    const p = this.path(runId);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunRecord) : null;
  }

  list(): RunRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RunRecord);
  }

  remove(runId: string) { rmSync(this.path(runId), { force: true }); }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner/src/statefile.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(runner): atomic per-run state files"
```

---

### Task 7: RunManager prepare and cleanup

**Files:**
- Create: `packages/runner/src/runs.ts`
- Test: `packages/runner/src/runs.test.ts`

**Interfaces:**
- Consumes: `Herdr`, `HerdrError` (Task 4); `Git` (Task 5); `StateDir`, `RunRecord` (Task 6); `RunnerStartRequest`, `RunnerRunStatus`, `RunnerInput`, `parsePlanProgress` from `@tac/shared`.
- Produces: `class RunManager` with constructor `(deps: { herdr: Herdr; git: Git; state: StateDir; worktreeRoot: string; exec: Exec })` and methods:
  - `checkPlan(repoPath: string, baseBranch: string, planPath: string): Promise<boolean>` (fetch then `planExists`);
  - `start(req: RunnerStartRequest): Promise<RunRecord>`;
  - `status(runId: string): Promise<RunnerRunStatus>` (Task 8);
  - `input(runId: string, input: RunnerInput): Promise<void>` (Task 8);
  - `screen(runId: string, lines: number): Promise<string>` (Task 8);
  - `cancel(runId: string): Promise<void>`;
  - `cleanup(runId: string): Promise<void>`;
  - `class RunNotFound extends Error`.

Behavior of `start`:
1. Throw `HerdrError("plan_not_found", ...)` if `checkPlan` is false.
2. `worktreePath = join(worktreeRoot, req.project, req.runId)`; `git.addWorktree(req.repoPath, worktreePath, req.branch, req.baseBranch)`.
3. Find the herdr workspace labeled `tac:<project>` with `listWorkspaces`; create it with `createWorkspace(worktreeRoot/<project>, "tac:<project>")` if missing.
4. `createTab(workspaceId, worktreePath, req.runId)`.
5. Save the record with `promptSent: false` **before** starting the agent, so a crash after this point is recoverable.
6. `startAgent(req.runId, req.agent, paneId, req.agentArgs)`. If it returns `"ready"`, `prompt(req.runId, req.prompt)` and save `promptSent: true`. If `"blocked"`, leave `promptSent: false`; `status()` sends the prompt later (Task 8).

`cancel`: `sendKeys(runId, ["ctrl+c"])` twice, then `closeTab(tabId)`; ignore `agent_not_found`. Keeps the worktree and state file.
`cleanup`: `cancel` if the agent is still present, `git.removeWorktree`, `state.remove`.

- [ ] **Step 1: Write the failing test with fakes**

`packages/runner/src/runs.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerStartRequest } from "@tac/shared";
import { RunManager } from "./runs";
import { StateDir } from "./statefile";
import { HerdrError } from "./herdr";

export function fakes(opts: { planExists?: boolean; start?: "ready" | "blocked" } = {}) {
  const log: string[] = [];
  const agents = new Map<string, { agentStatus: string; paneId: string; tabId: string }>();
  let ws: { workspaceId: string; label: string }[] = [];
  let tab = 1;
  const herdr: any = {
    listWorkspaces: async () => ws,
    createWorkspace: async (_: string, label: string) => { ws.push({ workspaceId: "w1", label }); log.push(`ws ${label}`); return { workspaceId: "w1", paneId: "w1:p1" }; },
    createTab: async (_w: string, cwd: string, label: string) => { tab++; log.push(`tab ${label} ${cwd}`); return { tabId: `w1:t${tab}`, paneId: `w1:p${tab}` }; },
    closeTab: async (id: string) => { log.push(`close ${id}`); },
    startAgent: async (name: string, _k: string, paneId: string) => {
      const st = opts.start ?? "ready";
      agents.set(name, { agentStatus: st === "ready" ? "idle" : "blocked", paneId, tabId: "" });
      log.push(`start ${name}`); return st;
    },
    getAgent: async (name: string) => {
      const a = agents.get(name);
      return a ? { name, agentStatus: a.agentStatus, paneId: a.paneId, tabId: a.tabId, workspaceId: "w1", cwd: "", launchPending: false } : null;
    },
    prompt: async (name: string, text: string) => {
      if (agents.get(name)?.agentStatus === "blocked") throw new HerdrError("agent_blocked", "blocked");
      log.push(`prompt ${name} ${text}`);
    },
    sendKeys: async (name: string, keys: string[]) => { log.push(`keys ${name} ${keys.join(" ")}`); },
    sendText: async (pane: string, text: string) => { log.push(`text ${pane} ${text}`); },
    readPane: async () => "screen",
  };
  const git: any = {
    fetch: async () => {},
    planExists: async () => opts.planExists ?? true,
    addWorktree: async (_r: string, w: string, b: string) => { log.push(`wt ${w} ${b}`); },
    removeWorktree: async (_r: string, w: string) => { log.push(`rmwt ${w}`); },
    headSha: async () => "a".repeat(40),
  };
  const state = new StateDir(mkdtempSync(join(tmpdir(), "tac-rm-")));
  const exec: any = async () => ({ code: 0, stdout: "[]", stderr: "" });
  const mgr = new RunManager({ herdr, git, state, worktreeRoot: "/wt", exec });
  return { mgr, log, agents, state };
}

export const req = (runId: string): RunnerStartRequest => ({
  runId, project: "proj", repoPath: "/repo", baseBranch: "main", planPath: "docs/p.md",
  branch: `run/${runId}-p`, agent: "claude", agentArgs: [], prompt: "execute docs/p.md",
});

test("start creates worktree, tab, agent and sends the prompt when ready", async () => {
  const { mgr, log, state } = fakes();
  await mgr.start(req("raaaaaaaa"));
  expect(log).toEqual([
    "wt /wt/proj/raaaaaaaa run/raaaaaaaa-p", "ws tac:proj", "tab raaaaaaaa /wt/proj/raaaaaaaa",
    "start raaaaaaaa", "prompt raaaaaaaa execute docs/p.md",
  ]);
  expect(state.load("raaaaaaaa")?.promptSent).toBe(true);
});

test("two runs of one project reuse the workspace and get separate worktrees", async () => {
  const { mgr, log } = fakes();
  await mgr.start(req("raaaaaaaa"));
  await mgr.start(req("rbbbbbbbb"));
  expect(log.filter((l) => l.startsWith("ws "))).toHaveLength(1);
  expect(log.filter((l) => l.startsWith("wt "))).toEqual([
    "wt /wt/proj/raaaaaaaa run/raaaaaaaa-p", "wt /wt/proj/rbbbbbbbb run/rbbbbbbbb-p",
  ]);
});

test("blocked startup leaves the prompt unsent", async () => {
  const { mgr, log, state } = fakes({ start: "blocked" });
  await mgr.start(req("raaaaaaaa"));
  expect(log.some((l) => l.startsWith("prompt"))).toBe(false);
  expect(state.load("raaaaaaaa")?.promptSent).toBe(false);
});

test("unpushed plan is rejected before anything is created", async () => {
  const { mgr, log, state } = fakes({ planExists: false });
  const err = await mgr.start(req("raaaaaaaa")).catch((e) => e);
  expect(err.code).toBe("plan_not_found");
  expect(log).toEqual([]);
  expect(state.list()).toEqual([]);
});

test("cleanup cancels, removes worktree and state", async () => {
  const { mgr, log, state } = fakes();
  await mgr.start(req("raaaaaaaa"));
  await mgr.cleanup("raaaaaaaa");
  expect(log).toContain("keys raaaaaaaa ctrl+c");
  expect(log).toContain("rmwt /wt/proj/raaaaaaaa");
  expect(state.load("raaaaaaaa")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/runner/src/runs.test.ts`
Expected: FAIL, cannot find module `./runs`.

- [ ] **Step 3: Implement `start`, `cancel`, `cleanup`, `checkPlan`**

`packages/runner/src/runs.ts`:
```ts
import { join } from "node:path";
import { parsePlanProgress, type RunnerInput, type RunnerRunStatus, type RunnerStartRequest } from "@tac/shared";
import type { Exec } from "./exec";
import type { Git } from "./git";
import { HerdrError, type Herdr } from "./herdr";
import type { RunRecord, StateDir } from "./statefile";

export class RunNotFound extends Error {
  constructor(runId: string) { super(`run ${runId} not found`); }
}

export interface RunManagerDeps { herdr: Herdr; git: Git; state: StateDir; worktreeRoot: string; exec: Exec }

export class RunManager {
  constructor(private d: RunManagerDeps) {}

  private record(runId: string): RunRecord {
    const r = this.d.state.load(runId);
    if (!r) throw new RunNotFound(runId);
    return r;
  }

  async checkPlan(repoPath: string, baseBranch: string, planPath: string) {
    await this.d.git.fetch(repoPath);
    return this.d.git.planExists(repoPath, baseBranch, planPath);
  }

  async start(req: RunnerStartRequest): Promise<RunRecord> {
    if (!(await this.checkPlan(req.repoPath, req.baseBranch, req.planPath)))
      throw new HerdrError("plan_not_found", `${req.planPath} is not on origin/${req.baseBranch}`);

    const worktreePath = join(this.d.worktreeRoot, req.project, req.runId);
    await this.d.git.addWorktree(req.repoPath, worktreePath, req.branch, req.baseBranch);

    const label = `tac:${req.project}`;
    const found = (await this.d.herdr.listWorkspaces()).find((w) => w.label === label);
    const workspaceId = found
      ? found.workspaceId
      : (await this.d.herdr.createWorkspace(join(this.d.worktreeRoot, req.project), label)).workspaceId;
    const { tabId, paneId } = await this.d.herdr.createTab(workspaceId, worktreePath, req.runId);

    const rec: RunRecord = { ...req, worktreePath, workspaceId, tabId, paneId, promptSent: false, createdAt: Date.now() };
    this.d.state.save(rec);

    const started = await this.d.herdr.startAgent(req.runId, req.agent, paneId, req.agentArgs);
    if (started === "ready") {
      await this.d.herdr.prompt(req.runId, req.prompt);
      rec.promptSent = true;
      this.d.state.save(rec);
    }
    return rec;
  }

  async cancel(runId: string) {
    const rec = this.record(runId);
    for (let i = 0; i < 2; i++) {
      try { await this.d.herdr.sendKeys(runId, ["ctrl+c"]); }
      catch (e) { if (!(e instanceof HerdrError && e.code === "agent_not_found")) throw e; }
    }
    try { await this.d.herdr.closeTab(rec.tabId); } catch {}
  }

  async cleanup(runId: string) {
    const rec = this.record(runId);
    if (await this.d.herdr.getAgent(runId)) await this.cancel(runId);
    await this.d.git.removeWorktree(rec.repoPath, rec.worktreePath);
    this.d.state.remove(runId);
  }

  // status, input, screen: Task 8
  async status(_runId: string): Promise<RunnerRunStatus> { throw new Error("not implemented"); }
  async input(_runId: string, _input: RunnerInput): Promise<void> { throw new Error("not implemented"); }
  async screen(_runId: string, _lines: number): Promise<string> { throw new Error("not implemented"); }
}
```

(The three stubs are replaced in Task 8 of this same plan; they exist only so the class compiles now.)

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner/src/runs.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(runner): run preparation and cleanup"
```

---

### Task 8: RunManager status, deferred prompt, input and screen

**Files:**
- Modify: `packages/runner/src/runs.ts` (replace the three stubs)
- Test: `packages/runner/src/runs-status.test.ts`

**Interfaces:**
- Consumes: everything from Task 7; `fakes`, `req` exported from `runs.test.ts`.
- Produces: real `status`, `input`, `screen` as declared in Task 7.

Behavior of `status(runId)`:
1. No state file → `{ runId, known: false, agentPresent: false, agentStatus: null, promptSent: false, progress: null, prUrl: null, headSha: null }`.
2. `agent = herdr.getAgent(runId)`.
3. Deferred prompt: if `agent` is present, `!rec.promptSent`, and `agent.agentStatus` is `idle` or `done`, call `herdr.prompt(runId, rec.prompt)`, save `promptSent: true`, and report `agentStatus: "working"` for this poll (so `control` does not see an idle agent with a sent prompt and start the idle timer at once). An `agent_blocked` error leaves `promptSent: false`.
4. `progress`: read `join(rec.worktreePath, rec.planPath)` if it exists and parse with `parsePlanProgress`; else `null`.
5. `prUrl`: run `gh pr list --head <branch> --state all --json url --limit 1` with `cwd = rec.worktreePath` via `exec`; parse the JSON array; first `url` or `null`. Any failure gives `null`.
6. `headSha` from `git.headSha(rec.worktreePath)`.

`input(runId, input)`: `prompt` → `herdr.prompt`; `keys` → `herdr.sendKeys`; `text` → `herdr.sendText(rec.paneId, text)`. herdr errors propagate unchanged (with their `code`). Unknown run → `RunNotFound`.

`screen(runId, lines)`: `herdr.readPane(rec.paneId, lines, "ansi")`.

A runner restart needs no special code: all inputs to `status` come from the state file and herdr, so a new process reports the same facts (Review Focus 2).

- [ ] **Step 1: Write the failing tests**

`packages/runner/src/runs-status.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/runner/src/runs-status.test.ts`
Expected: FAIL with "not implemented".

- [ ] **Step 3: Replace the stubs in `runs.ts`**

```ts
  async status(runId: string): Promise<RunnerRunStatus> {
    const rec = this.d.state.load(runId);
    if (!rec) return { runId, known: false, agentPresent: false, agentStatus: null, promptSent: false, progress: null, prUrl: null, headSha: null };

    const agent = await this.d.herdr.getAgent(runId);
    let agentStatus = agent?.agentStatus ?? null;

    if (agent && !rec.promptSent && (agentStatus === "idle" || agentStatus === "done")) {
      try {
        await this.d.herdr.prompt(runId, rec.prompt);
        rec.promptSent = true;
        this.d.state.save(rec);
        agentStatus = "working";
      } catch (e) {
        if (!(e instanceof HerdrError && e.code === "agent_blocked")) throw e;
      }
    }

    const planFile = Bun.file(join(rec.worktreePath, rec.planPath));
    const progress = (await planFile.exists()) ? parsePlanProgress(await planFile.text()) : null;

    let prUrl: string | null = null;
    try {
      const r = await this.d.exec(["gh", "pr", "list", "--head", rec.branch, "--state", "all", "--json", "url", "--limit", "1"], { cwd: rec.worktreePath });
      if (r.code === 0) prUrl = (JSON.parse(r.stdout) as { url: string }[])[0]?.url ?? null;
    } catch {}

    return {
      runId, known: true, agentPresent: agent !== null, agentStatus, promptSent: rec.promptSent,
      progress, prUrl, headSha: await this.d.git.headSha(rec.worktreePath),
    };
  }

  async input(runId: string, input: RunnerInput): Promise<void> {
    const rec = this.record(runId);
    if (input.type === "prompt") return this.d.herdr.prompt(runId, input.text);
    if (input.type === "keys") return this.d.herdr.sendKeys(runId, input.keys);
    return this.d.herdr.sendText(rec.paneId, input.text);
  }

  async screen(runId: string, lines: number): Promise<string> {
    return this.d.herdr.readPane(this.record(runId).paneId, lines, "ansi");
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/runner && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(runner): status with deferred prompt, input and screen"
```

---

### Task 9: Runner HTTP server and entrypoint

**Files:**
- Create: `packages/runner/src/server.ts`, `packages/runner/src/main.ts`
- Modify: `packages/runner/package.json` (add `"hono": "^4.6.0"`, `"zod": "^3.23.0"`)
- Test: `packages/runner/src/server.test.ts`

**Interfaces:**
- Consumes: `RunManager`, `RunNotFound` (Tasks 7-8), `HerdrError` (Task 4), `GitError` (Task 5).
- Produces: `createRunnerApp(mgr: RunManager, token: string): Hono` with routes:
  - `GET /health` → `200 {"ok": true}` (no auth)
  - `POST /check-plan` body `{repoPath, baseBranch, planPath}` → `{ exists: boolean }`
  - `POST /runs` body `RunnerStartRequest` → `201 {runId, worktreePath}`
  - `GET /runs/:id/status` → `RunnerRunStatus`
  - `POST /runs/:id/input` body `RunnerInput` → `204`
  - `GET /runs/:id/screen?lines=N` → `200 text/plain` (N default 200, max 2000)
  - `POST /runs/:id/cancel` → `204`; `POST /runs/:id/cleanup` → `204`
  - Errors: `401 {error:{code:"unauthorized"}}`; `400` for zod failures with code `bad_request`; `404` for `RunNotFound` with code `run_not_found`; `409` for `HerdrError` with herdr's code (`plan_not_found` uses `422`); `500` with code `git_error` for `GitError`.
- Environment for `main.ts`: `TAC_RUNNER_TOKEN` (required), `TAC_RUNNER_LISTEN` (default `127.0.0.1:7781`), `TAC_WORKTREE_ROOT` (default `~/worktrees`), `TAC_STATE_DIR` (default `~/.local/state/tac-runner/runs`), `TAC_HERDR_SESSION` (optional).

- [ ] **Step 1: Write the failing test**

`packages/runner/src/server.test.ts`:
```ts
import { expect, test } from "bun:test";
import { createRunnerApp } from "./server";
import { fakes, req } from "./runs.test";

const auth = { Authorization: "Bearer s3cret", "content-type": "application/json" };

test("health needs no token, everything else does", async () => {
  const app = createRunnerApp(fakes().mgr, "s3cret");
  expect((await app.request("/health")).status).toBe(200);
  expect((await app.request("/runs/raaaaaaaa/status")).status).toBe(401);
  expect((await app.request("/runs/raaaaaaaa/status", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
});

test("start then status", async () => {
  const app = createRunnerApp(fakes().mgr, "s3cret");
  const r = await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) });
  expect(r.status).toBe(201);
  const s = await (await app.request("/runs/raaaaaaaa/status", { headers: auth })).json();
  expect(s.known).toBe(true);
});

test("plan_not_found is 422, bad body is 400, unknown run is 404", async () => {
  const app = createRunnerApp(fakes({ planExists: false }).mgr, "s3cret");
  expect((await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) })).status).toBe(422);
  expect((await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify({ runId: "x" }) })).status).toBe(400);
  expect((await app.request("/runs/rzzzzzzzz/input", { method: "POST", headers: auth, body: JSON.stringify({ type: "keys", keys: ["enter"] }) })).status).toBe(404);
});

test("input with a blocked agent returns 409 with herdr code", async () => {
  const f = fakes();
  const app = createRunnerApp(f.mgr, "s3cret");
  await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) });
  f.agents.get("raaaaaaaa")!.agentStatus = "blocked";
  const r = await app.request("/runs/raaaaaaaa/input", { method: "POST", headers: auth, body: JSON.stringify({ type: "prompt", text: "hi" }) });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("agent_blocked");
});

test("run ids that are not valid are rejected", async () => {
  const app = createRunnerApp(fakes().mgr, "s3cret");
  expect((await app.request("/runs/..%2Fx/status", { headers: auth })).status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/runner && bun add hono@^4.6.0 zod@^3.23.0 && cd ../.. && bun test packages/runner/src/server.test.ts`
Expected: FAIL, cannot find module `./server`.

- [ ] **Step 3: Implement**

`packages/runner/src/server.ts`:
```ts
import { Hono } from "hono";
import { z } from "zod";
import { GitError } from "./git";
import { HerdrError } from "./herdr";
import { RunNotFound, type RunManager } from "./runs";

const RunId = z.string().regex(/^r[a-z0-9]{8}$/);
const StartReq = z.object({
  runId: RunId, project: z.string().regex(/^[a-zA-Z0-9_.-]+$/), repoPath: z.string().min(1),
  baseBranch: z.string().min(1), planPath: z.string().min(1), branch: z.string().startsWith("run/"),
  agent: z.enum(["claude", "codex"]), agentArgs: z.array(z.string()), prompt: z.string().min(1),
});
const Input = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ type: z.literal("keys"), keys: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
]);
const CheckPlan = z.object({ repoPath: z.string(), baseBranch: z.string(), planPath: z.string() });

const err = (code: string, message = code) => ({ error: { code, message } });

export function createRunnerApp(mgr: RunManager, token: string) {
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof z.ZodError) return c.json(err("bad_request", e.message), 400);
    if (e instanceof RunNotFound) return c.json(err("run_not_found", e.message), 404);
    if (e instanceof HerdrError) return c.json(err(e.code, e.message), e.code === "plan_not_found" ? 422 : 409);
    if (e instanceof GitError) return c.json(err("git_error", e.stderr), 500);
    return c.json(err("internal", String(e)), 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${token}`) return c.json(err("unauthorized"), 401);
    await next();
  });

  const id = (raw: string) => RunId.parse(raw);

  app.post("/check-plan", async (c) => {
    const b = CheckPlan.parse(await c.req.json());
    return c.json({ exists: await mgr.checkPlan(b.repoPath, b.baseBranch, b.planPath) });
  });
  app.post("/runs", async (c) => {
    const rec = await mgr.start(StartReq.parse(await c.req.json()));
    return c.json({ runId: rec.runId, worktreePath: rec.worktreePath }, 201);
  });
  app.get("/runs/:id/status", async (c) => c.json(await mgr.status(id(c.req.param("id")))));
  app.post("/runs/:id/input", async (c) => {
    await mgr.input(id(c.req.param("id")), Input.parse(await c.req.json()));
    return c.body(null, 204);
  });
  app.get("/runs/:id/screen", async (c) => {
    const lines = Math.min(Math.max(Number(c.req.query("lines") ?? 200) || 200, 1), 2000);
    return c.text(await mgr.screen(id(c.req.param("id")), lines));
  });
  app.post("/runs/:id/cancel", async (c) => { await mgr.cancel(id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/runs/:id/cleanup", async (c) => { await mgr.cleanup(id(c.req.param("id"))); return c.body(null, 204); });

  return app;
}
```

`packages/runner/src/main.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { realExec } from "./exec";
import { Git } from "./git";
import { Herdr } from "./herdr";
import { RunManager } from "./runs";
import { createRunnerApp } from "./server";
import { StateDir } from "./statefile";

const token = process.env.TAC_RUNNER_TOKEN;
if (!token) { console.error("TAC_RUNNER_TOKEN is required"); process.exit(1); }
const [hostname, port] = (process.env.TAC_RUNNER_LISTEN ?? "127.0.0.1:7781").split(":");
const home = homedir();

const mgr = new RunManager({
  herdr: new Herdr(realExec, "herdr", process.env.TAC_HERDR_SESSION),
  git: new Git(realExec),
  state: new StateDir(process.env.TAC_STATE_DIR ?? join(home, ".local/state/tac-runner/runs")),
  worktreeRoot: process.env.TAC_WORKTREE_ROOT ?? join(home, "worktrees"),
  exec: realExec,
});

Bun.serve({ hostname, port: Number(port), fetch: createRunnerApp(mgr, token).fetch });
console.log(`tac-runner listening on ${hostname}:${port}`);
```

Add to `packages/runner/package.json` scripts: `"start": "bun src/main.ts"`, `"build": "bun build src/main.ts --compile --target=bun-linux-x64 --outfile dist/tac-runner"`.

- [ ] **Step 4: Run tests and build**

Run: `bun test packages/runner && bun run typecheck && (cd packages/runner && bun run build) && ls -la packages/runner/dist/tac-runner`
Expected: all tests pass; a `tac-runner` linux binary exists (it needs no Bun on the devbox).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(runner): token-protected HTTP API and entrypoint"
```

---

### Task 10: Control config, store and dispatch

**Files:**
- Create: `packages/control/src/config.ts`, `packages/control/src/store.ts`, `packages/control/src/runner-client.ts`, `packages/control/src/dispatch.ts`
- Modify: `packages/control/package.json` (add `hono`, `zod`, `yaml@^2.5.0`)
- Test: `packages/control/src/config.test.ts`, `packages/control/src/store.test.ts`, `packages/control/src/dispatch.test.ts`

**Interfaces:**
- Consumes: `Run`, `RunEvent`, `RunState`, `RunnerRunStatus`, `RunnerStartRequest`, `RunnerInput`, `newRunId`, `branchName`, `assertTransition`, `ACTIVE_STATES` from `@tac/shared`.
- Produces:
  - `interface ProjectConfig { name: string; host: string; repoPath: string; baseBranch: string; agent: AgentKind; agentArgs: string[] }`
  - `interface HostConfig { name: string; url: string; token: string; maxRuns: number }`
  - `loadConfig(projectsYaml: string, hostsYaml: string, env: Record<string, string | undefined>): { projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig> }` — host tokens come from env `TAC_TOKEN_<HOST>` (host name upper-cased, `-` → `_`); throws `ConfigError` naming the problem.
  - `class Store` with constructor `(path: string)` (`":memory:"` in tests) and methods: `insertRun(r: Run): void`, `getRun(id: string): Run | null`, `listRuns(opts?: { states?: RunState[]; limit?: number }): Run[]` (newest first), `updateRun(id: string, patch: Partial<Run>): Run` (asserts state transitions when `patch.state` is set and sets `updatedAt`), `deleteRun(id: string): void`, `addEvent(e: RunEvent): void`, `events(runId: string): RunEvent[]`, `countActive(host: string): number`, `oldestQueued(host: string): Run | null`.
  - `interface RunnerClient { health(): Promise<boolean>; checkPlan(b: {repoPath: string; baseBranch: string; planPath: string}): Promise<boolean>; start(r: RunnerStartRequest): Promise<void>; status(id: string): Promise<RunnerRunStatus>; input(id: string, i: RunnerInput): Promise<void>; screen(id: string, lines: number): Promise<string>; cancel(id: string): Promise<void>; cleanup(id: string): Promise<void> }`; `class HttpRunnerClient implements RunnerClient` (constructor `(host: HostConfig, fetchImpl = fetch)`); `class RunnerCallError extends Error { status: number; code: string }`.
  - `class DispatchError extends Error { code: string }`.
  - `dispatch(deps: { store: Store; projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig>; client: (host: string) => RunnerClient; now: () => number }, input: { project: string; planPath: string; host?: string; agent?: AgentKind }): Promise<Run>` — validates the project and host, calls `checkPlan` on the host's runner, and only then inserts a `queued` run plus a `dispatch` event. On `exists: false` it throws `DispatchError("plan_not_found")` and inserts nothing.
  - `buildPrompt(planPath: string): string` returns `Execute the plan at <planPath> using the superpowers:subagent-driven-development skill. When all tasks are done, open a pull request from the current branch.`

Config file formats:

`projects.yaml`:
```yaml
projects:
  leiloes_veiculos:
    host: devbox-homelab
    repoPath: /home/apretto/workspace/leiloes_veiculos
    baseBranch: main
    agent: claude
    agentArgs: []
```

`hosts.yaml`:
```yaml
hosts:
  devbox-homelab:
    url: http://devbox-homelab.tail39ebd.ts.net:7781
    maxRuns: 2
```

SQLite schema (created in the `Store` constructor):
```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL,
  plan_path TEXT NOT NULL, base_branch TEXT NOT NULL, branch TEXT NOT NULL, state TEXT NOT NULL,
  pr_url TEXT, progress TEXT, idle_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_host_state ON runs(host, state);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, at);
```
`progress` and `data` are JSON text. Open with `PRAGMA journal_mode = WAL`.

- [ ] **Step 1: Write the failing tests**

`packages/control/src/config.test.ts`:
```ts
import { expect, test } from "bun:test";
import { ConfigError, loadConfig } from "./config";

const P = `projects:\n  leiloes_veiculos:\n    host: devbox-homelab\n    repoPath: /home/a/workspace/leiloes_veiculos\n    baseBranch: main\n    agent: claude\n    agentArgs: ["--model", "haiku"]\n`;
const H = `hosts:\n  devbox-homelab:\n    url: http://devbox-homelab:7781\n    maxRuns: 2\n`;

test("loads projects and hosts with tokens from env", () => {
  const c = loadConfig(P, H, { TAC_TOKEN_DEVBOX_HOMELAB: "t1" });
  expect(c.projects.get("leiloes_veiculos")?.agentArgs).toEqual(["--model", "haiku"]);
  expect(c.hosts.get("devbox-homelab")).toEqual({ name: "devbox-homelab", url: "http://devbox-homelab:7781", token: "t1", maxRuns: 2 });
});

test("missing token, unknown host and bad agent fail with a clear message", () => {
  expect(() => loadConfig(P, H, {})).toThrow("TAC_TOKEN_DEVBOX_HOMELAB");
  expect(() => loadConfig(P.replace("devbox-homelab", "nope"), H, { TAC_TOKEN_DEVBOX_HOMELAB: "t" })).toThrow(ConfigError);
  expect(() => loadConfig(P.replace("agent: claude", "agent: gpt"), H, { TAC_TOKEN_DEVBOX_HOMELAB: "t" })).toThrow(ConfigError);
});
```

`packages/control/src/store.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { Run } from "@tac/shared";
import { Store } from "./store";

export const run = (id: string, over: Partial<Run> = {}): Run => ({
  id, project: "p", host: "h1", agent: "claude", planPath: "a.md", baseBranch: "main", branch: `run/${id}-a`,
  state: "queued", prUrl: null, progress: null, idleSince: null, createdAt: 1, updatedAt: 1,
  startedAt: null, finishedAt: null, ...over,
});

test("insert, get, update with transition check", () => {
  const s = new Store(":memory:");
  s.insertRun(run("raaaaaaaa"));
  expect(s.updateRun("raaaaaaaa", { state: "preparing" }).state).toBe("preparing");
  expect(() => s.updateRun("raaaaaaaa", { state: "queued" })).toThrow("invalid transition");
  s.updateRun("raaaaaaaa", { progress: { waves: [], done: 1, total: 2 } });
  expect(s.getRun("raaaaaaaa")?.progress?.total).toBe(2);
});

test("capacity helpers", () => {
  const s = new Store(":memory:");
  s.insertRun(run("raaaaaaaa", { createdAt: 2 }));
  s.insertRun(run("rbbbbbbbb", { createdAt: 1 }));
  s.insertRun(run("rcccccccc", { state: "running" }));
  s.insertRun(run("rdddddddd", { state: "succeeded" }));
  s.insertRun(run("reeeeeeee", { host: "h2", state: "running" }));
  expect(s.countActive("h1")).toBe(1);
  expect(s.oldestQueued("h1")?.id).toBe("rbbbbbbbb");
});

test("events are append-only and ordered", () => {
  const s = new Store(":memory:");
  s.addEvent({ runId: "raaaaaaaa", at: 2, kind: "input", source: "user", data: { text: "b" } });
  s.addEvent({ runId: "raaaaaaaa", at: 1, kind: "state", source: "control", data: { to: "running" } });
  expect(s.events("raaaaaaaa").map((e) => e.at)).toEqual([1, 2]);
});
```

`packages/control/src/dispatch.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/control && bun add hono@^4.6.0 zod@^3.23.0 yaml@^2.5.0 && cd ../.. && bun test packages/control`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `config.ts`**

```ts
import { parse } from "yaml";
import { z } from "zod";
import type { AgentKind } from "@tac/shared";

export class ConfigError extends Error {}
export interface ProjectConfig { name: string; host: string; repoPath: string; baseBranch: string; agent: AgentKind; agentArgs: string[] }
export interface HostConfig { name: string; url: string; token: string; maxRuns: number }

const Projects = z.object({ projects: z.record(z.object({
  host: z.string(), repoPath: z.string().startsWith("/"), baseBranch: z.string().default("main"),
  agent: z.enum(["claude", "codex"]).default("claude"), agentArgs: z.array(z.string()).default([]),
})) });
const Hosts = z.object({ hosts: z.record(z.object({ url: z.string().url(), maxRuns: z.number().int().min(1).default(2) })) });

export function loadConfig(projectsYaml: string, hostsYaml: string, env: Record<string, string | undefined>) {
  const p = Projects.safeParse(parse(projectsYaml));
  if (!p.success) throw new ConfigError(`projects.yaml: ${p.error.message}`);
  const h = Hosts.safeParse(parse(hostsYaml));
  if (!h.success) throw new ConfigError(`hosts.yaml: ${h.error.message}`);

  const hosts = new Map<string, HostConfig>();
  for (const [name, v] of Object.entries(h.data.hosts)) {
    const key = `TAC_TOKEN_${name.toUpperCase().replace(/-/g, "_")}`;
    const token = env[key];
    if (!token) throw new ConfigError(`missing ${key} for host ${name}`);
    hosts.set(name, { name, url: v.url, token, maxRuns: v.maxRuns });
  }
  const projects = new Map<string, ProjectConfig>();
  for (const [name, v] of Object.entries(p.data.projects)) {
    if (!hosts.has(v.host)) throw new ConfigError(`project ${name}: unknown host ${v.host}`);
    projects.set(name, { name, ...v });
  }
  return { projects, hosts };
}
```

- [ ] **Step 4: Implement `store.ts`**

```ts
import { Database } from "bun:sqlite";
import { ACTIVE_STATES, assertTransition, type Run, type RunEvent, type RunState } from "@tac/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL,
  plan_path TEXT NOT NULL, base_branch TEXT NOT NULL, branch TEXT NOT NULL, state TEXT NOT NULL,
  pr_url TEXT, progress TEXT, idle_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_host_state ON runs(host, state);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, at);
`;

const toRun = (r: any): Run => ({
  id: r.id, project: r.project, host: r.host, agent: r.agent, planPath: r.plan_path, baseBranch: r.base_branch,
  branch: r.branch, state: r.state, prUrl: r.pr_url, progress: r.progress ? JSON.parse(r.progress) : null,
  idleSince: r.idle_since, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, finishedAt: r.finished_at,
});
const COLS: Record<keyof Run, string> = {
  id: "id", project: "project", host: "host", agent: "agent", planPath: "plan_path", baseBranch: "base_branch",
  branch: "branch", state: "state", prUrl: "pr_url", progress: "progress", idleSince: "idle_since",
  createdAt: "created_at", updatedAt: "updated_at", startedAt: "started_at", finishedAt: "finished_at",
};
const val = (k: keyof Run, v: unknown) => (k === "progress" && v != null ? JSON.stringify(v) : v);

export class Store {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  insertRun(r: Run) {
    const keys = Object.keys(COLS) as (keyof Run)[];
    this.db.prepare(`INSERT INTO runs (${keys.map((k) => COLS[k]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => val(k, r[k]) as any));
  }

  getRun(id: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return r ? toRun(r) : null;
  }

  listRuns(opts: { states?: RunState[]; limit?: number } = {}): Run[] {
    const where = opts.states?.length ? `WHERE state IN (${opts.states.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(opts.states ?? []), opts.limit ?? 200).map(toRun);
  }

  updateRun(id: string, patch: Partial<Run>): Run {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run ${id} not found`);
    if (patch.state && patch.state !== cur.state) assertTransition(cur.state, patch.state);
    const next = { ...patch, updatedAt: patch.updatedAt ?? Date.now() };
    const keys = (Object.keys(next) as (keyof Run)[]).filter((k) => k !== "id");
    this.db.prepare(`UPDATE runs SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => val(k, next[k]) as any), id);
    return this.getRun(id)!;
  }

  deleteRun(id: string) { this.db.prepare("DELETE FROM runs WHERE id = ?").run(id); }

  addEvent(e: RunEvent) {
    this.db.prepare("INSERT INTO run_events (run_id, at, kind, source, data) VALUES (?, ?, ?, ?, ?)")
      .run(e.runId, e.at, e.kind, e.source, JSON.stringify(e.data));
  }

  events(runId: string): RunEvent[] {
    return this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY at, id").all(runId)
      .map((r: any) => ({ runId: r.run_id, at: r.at, kind: r.kind, source: r.source, data: JSON.parse(r.data) }));
  }

  countActive(host: string): number {
    const q = `SELECT COUNT(*) AS n FROM runs WHERE host = ? AND state IN (${ACTIVE_STATES.map(() => "?").join(",")})`;
    return (this.db.prepare(q).get(host, ...ACTIVE_STATES) as { n: number }).n;
  }

  oldestQueued(host: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE host = ? AND state = 'queued' ORDER BY created_at ASC LIMIT 1").get(host);
    return r ? toRun(r) : null;
  }
}
```

- [ ] **Step 5: Implement `runner-client.ts`**

```ts
import type { RunnerInput, RunnerRunStatus, RunnerStartRequest } from "@tac/shared";
import type { HostConfig } from "./config";

export class RunnerCallError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface RunnerClient {
  health(): Promise<boolean>;
  checkPlan(b: { repoPath: string; baseBranch: string; planPath: string }): Promise<boolean>;
  start(r: RunnerStartRequest): Promise<void>;
  status(id: string): Promise<RunnerRunStatus>;
  input(id: string, i: RunnerInput): Promise<void>;
  screen(id: string, lines: number): Promise<string>;
  cancel(id: string): Promise<void>;
  cleanup(id: string): Promise<void>;
}

export class HttpRunnerClient implements RunnerClient {
  constructor(private host: HostConfig, private fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchImpl(`${this.host.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.host.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      throw new RunnerCallError(res.status, j?.error?.code ?? `http_${res.status}`, j?.error?.message ?? res.statusText);
    }
    return res;
  }

  async health() {
    try { return (await this.fetchImpl(`${this.host.url}/health`, { signal: AbortSignal.timeout(5_000) })).ok; }
    catch { return false; }
  }
  async checkPlan(b: { repoPath: string; baseBranch: string; planPath: string }) {
    return ((await (await this.call("POST", "/check-plan", b)).json()) as { exists: boolean }).exists;
  }
  async start(r: RunnerStartRequest) { await this.call("POST", "/runs", r); }
  async status(id: string) { return (await (await this.call("GET", `/runs/${id}/status`)).json()) as RunnerRunStatus; }
  async input(id: string, i: RunnerInput) { await this.call("POST", `/runs/${id}/input`, i); }
  async screen(id: string, lines: number) { return (await this.call("GET", `/runs/${id}/screen?lines=${lines}`)).text(); }
  async cancel(id: string) { await this.call("POST", `/runs/${id}/cancel`); }
  async cleanup(id: string) { await this.call("POST", `/runs/${id}/cleanup`); }
}
```

- [ ] **Step 6: Implement `dispatch.ts`**

```ts
import { branchName, newRunId, type AgentKind, type Run } from "@tac/shared";
import type { HostConfig, ProjectConfig } from "./config";
import type { RunnerClient } from "./runner-client";
import type { Store } from "./store";

export class DispatchError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface DispatchDeps {
  store: Store; projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig>;
  client: (host: string) => RunnerClient; now: () => number;
}

export function buildPrompt(planPath: string) {
  return `Execute the plan at ${planPath} using the superpowers:subagent-driven-development skill. When all tasks are done, open a pull request from the current branch.`;
}

export async function dispatch(d: DispatchDeps, input: { project: string; planPath: string; host?: string; agent?: AgentKind }): Promise<Run> {
  const p = d.projects.get(input.project);
  if (!p) throw new DispatchError("unknown_project", `unknown project ${input.project}`);
  const host = input.host && input.host !== "auto" ? input.host : p.host;
  if (!d.hosts.has(host)) throw new DispatchError("unknown_host", `unknown host ${host}`);

  const exists = await d.client(host).checkPlan({ repoPath: p.repoPath, baseBranch: p.baseBranch, planPath: input.planPath });
  if (!exists) throw new DispatchError("plan_not_found", `${input.planPath} is not on origin/${p.baseBranch}; commit and push it first`);

  const id = newRunId();
  const now = d.now();
  const run: Run = {
    id, project: p.name, host, agent: input.agent ?? p.agent, planPath: input.planPath, baseBranch: p.baseBranch,
    branch: branchName(id, input.planPath), state: "queued", prUrl: null, progress: null, idleSince: null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
  };
  d.store.insertRun(run);
  d.store.addEvent({ runId: id, at: now, kind: "dispatch", source: "user", data: { planPath: input.planPath, host } });
  return run;
}
```

- [ ] **Step 7: Run tests**

Run: `bun test packages/control && bun run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(control): config, sqlite store, runner client and dispatch"
```

---

### Task 11: Decision function and control loop

**Files:**
- Create: `packages/control/src/decide.ts`, `packages/control/src/loop.ts`
- Test: `packages/control/src/decide.test.ts`, `packages/control/src/loop.test.ts`

**Interfaces:**
- Consumes: `Store`, `run` test helper (Task 10), `RunnerClient`, `HostConfig`, `ProjectConfig`, `buildPrompt`.
- Produces:
  - `decide(run: Run, s: RunnerRunStatus, now: number, idleTimeoutMs: number): { state: RunState; idleSince: number | null }` — pure.
  - `class ControlLoop` with constructor `(deps: { store: Store; projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig>; client: (host: string) => RunnerClient; now: () => number; idleTimeoutMs: number })` and methods `tick(): Promise<void>` (dispatch + reconcile), `healthTick(): Promise<void>`, `hostState(host: string): "ok" | "unreachable"`, `start(): void` (intervals 5 s and 15 s), `stop(): void`.

`decide` rules, in order:
1. `!s.known` → `failed` if the run was past `preparing` for more than 60 s (`now - run.startedAt > 60_000`), else keep the current state (the runner may still be creating it).
2. `!s.agentPresent` → `succeeded` if `s.prUrl`, else `failed`.
3. `s.prUrl` and agent `idle`/`done` → `succeeded`.
4. `blocked` → `waiting_input`, `idleSince: null`.
5. `working` → `running`, `idleSince: null`.
6. `idle`/`done` with `!s.promptSent` → keep the current state (prompt not delivered yet).
7. `idle`/`done` with no PR → `idleSince = run.idleSince ?? now`; `needs_attention` if `now - idleSince >= idleTimeoutMs`, else `finishing`.
8. `unknown` → keep the current state.

`ControlLoop.tick`:
1. Dispatch: for each host with `hostState == "ok"`, while `countActive(host) < maxRuns` and `oldestQueued(host)` exists: `updateRun(id, {state: "preparing", startedAt: now})`, add a `state` event, call `client(host).start(...)` with `agentArgs` from the project and `prompt = buildPrompt(planPath)`. On error: `updateRun(id, {state: "failed", finishedAt: now})` and add an `error` event with the code.
2. Reconcile: for each run in `ACTIVE_STATES` whose host is `ok` and whose state is not `queued`: get `status`, compute `decide`; if the state changed, `updateRun` (plus `finishedAt` for terminal states, `prUrl`, `progress`, `idleSince`) and add a `state` event; otherwise update only `progress`, `prUrl` and `idleSince` when they changed. A runner call error marks nothing; it is logged as an `error` event at most once per minute per run.
3. Runs whose host is `unreachable` move to `unknown` (once) with a `state` event.

`healthTick`: for each host call `health()`; 3 consecutive failures → `unreachable`; the first success resets the counter to 0 and the host to `ok`.

- [ ] **Step 1: Write the failing tests**

`packages/control/src/decide.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { RunnerRunStatus } from "@tac/shared";
import { decide } from "./decide";
import { run } from "./store.test";

const st = (o: Partial<RunnerRunStatus>): RunnerRunStatus => ({
  runId: "raaaaaaaa", known: true, agentPresent: true, agentStatus: "working", promptSent: true,
  progress: null, prUrl: null, headSha: null, ...o,
});
const T = 15 * 60_000;

test("working and blocked", () => {
  expect(decide(run("raaaaaaaa", { state: "preparing" }), st({}), 0, T).state).toBe("running");
  expect(decide(run("raaaaaaaa", { state: "running", idleSince: 5 }), st({ agentStatus: "blocked" }), 9, T))
    .toEqual({ state: "waiting_input", idleSince: null });
});

test("idle before the prompt is sent keeps the state", () => {
  expect(decide(run("raaaaaaaa", { state: "waiting_input" }), st({ agentStatus: "idle", promptSent: false }), 0, T).state).toBe("waiting_input");
});

test("idle without PR: finishing, then needs_attention after the timeout", () => {
  const r = run("raaaaaaaa", { state: "running" });
  expect(decide(r, st({ agentStatus: "idle" }), 1000, T)).toEqual({ state: "finishing", idleSince: 1000 });
  expect(decide({ ...r, state: "finishing", idleSince: 1000 }, st({ agentStatus: "done" }), 1000 + T, T).state).toBe("needs_attention");
});

test("PR wins; agent gone without PR fails", () => {
  expect(decide(run("raaaaaaaa", { state: "finishing" }), st({ agentStatus: "idle", prUrl: "https://x/pr/1" }), 0, T).state).toBe("succeeded");
  expect(decide(run("raaaaaaaa", { state: "running" }), st({ agentPresent: false, agentStatus: null }), 0, T).state).toBe("failed");
  expect(decide(run("raaaaaaaa", { state: "running" }), st({ agentPresent: false, agentStatus: null, prUrl: "u" }), 0, T).state).toBe("succeeded");
});

test("runner does not know the run: grace period, then failed", () => {
  const r = run("raaaaaaaa", { state: "preparing", startedAt: 0 });
  expect(decide(r, st({ known: false }), 30_000, T).state).toBe("preparing");
  expect(decide(r, st({ known: false }), 61_000, T).state).toBe("failed");
});
```

`packages/control/src/loop.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/control/src/decide.test.ts packages/control/src/loop.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `decide.ts`**

```ts
import type { Run, RunState, RunnerRunStatus } from "@tac/shared";

export function decide(run: Run, s: RunnerRunStatus, now: number, idleTimeoutMs: number): { state: RunState; idleSince: number | null } {
  const keep = { state: run.state, idleSince: run.idleSince };
  if (!s.known) {
    return run.startedAt !== null && now - run.startedAt > 60_000 ? { state: "failed", idleSince: null } : keep;
  }
  if (!s.agentPresent) return { state: s.prUrl ? "succeeded" : "failed", idleSince: null };
  const idle = s.agentStatus === "idle" || s.agentStatus === "done";
  if (s.prUrl && idle) return { state: "succeeded", idleSince: null };
  if (s.agentStatus === "blocked") return { state: "waiting_input", idleSince: null };
  if (s.agentStatus === "working") return { state: "running", idleSince: null };
  if (idle) {
    if (!s.promptSent) return keep;
    const idleSince = run.idleSince ?? now;
    return { state: now - idleSince >= idleTimeoutMs ? "needs_attention" : "finishing", idleSince };
  }
  return keep;
}
```

- [ ] **Step 4: Implement `loop.ts`**

```ts
import { ACTIVE_STATES, TERMINAL_STATES, type Run } from "@tac/shared";
import type { HostConfig, ProjectConfig } from "./config";
import { decide } from "./decide";
import { buildPrompt } from "./dispatch";
import type { RunnerClient } from "./runner-client";
import type { Store } from "./store";

export interface LoopDeps {
  store: Store; projects: Map<string, ProjectConfig>; hosts: Map<string, HostConfig>;
  client: (host: string) => RunnerClient; now: () => number; idleTimeoutMs: number;
}

export class ControlLoop {
  private failures = new Map<string, number>();
  private lastErrorAt = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private busy = false;

  constructor(private d: LoopDeps) {}

  hostState(host: string): "ok" | "unreachable" {
    return (this.failures.get(host) ?? 0) >= 3 ? "unreachable" : "ok";
  }

  async healthTick() {
    for (const host of this.d.hosts.keys()) {
      const ok = await this.d.client(host).health();
      this.failures.set(host, ok ? 0 : (this.failures.get(host) ?? 0) + 1);
    }
  }

  private setState(run: Run, patch: Partial<Run>) {
    const now = this.d.now();
    const terminal = patch.state && TERMINAL_STATES.includes(patch.state);
    const updated = this.d.store.updateRun(run.id, { ...patch, updatedAt: now, ...(terminal ? { finishedAt: now } : {}) });
    if (patch.state && patch.state !== run.state)
      this.d.store.addEvent({ runId: run.id, at: now, kind: "state", source: "control", data: { from: run.state, to: patch.state } });
    return updated;
  }

  private errorEvent(runId: string, code: string, message: string) {
    const now = this.d.now();
    if (now - (this.lastErrorAt.get(runId) ?? -Infinity) < 60_000) return;
    this.lastErrorAt.set(runId, now);
    this.d.store.addEvent({ runId, at: now, kind: "error", source: "control", data: { code, message } });
  }

  private async dispatchQueued() {
    for (const [host, cfg] of this.d.hosts) {
      if (this.hostState(host) !== "ok") continue;
      while (this.d.store.countActive(host) < cfg.maxRuns) {
        const run = this.d.store.oldestQueued(host);
        if (!run) break;
        const p = this.d.projects.get(run.project);
        const started = this.setState(run, { state: "preparing", startedAt: this.d.now() });
        try {
          if (!p) throw Object.assign(new Error(`unknown project ${run.project}`), { code: "unknown_project" });
          await this.d.client(host).start({
            runId: run.id, project: run.project, repoPath: p.repoPath, baseBranch: run.baseBranch,
            planPath: run.planPath, branch: run.branch, agent: run.agent, agentArgs: p.agentArgs, prompt: buildPrompt(run.planPath),
          });
        } catch (e: any) {
          this.setState(started, { state: "failed" });
          this.d.store.addEvent({ runId: run.id, at: this.d.now(), kind: "error", source: "control", data: { code: e?.code ?? "start_failed", message: String(e?.message ?? e) } });
        }
      }
    }
  }

  private async reconcile() {
    const active = this.d.store.listRuns({ states: [...ACTIVE_STATES], limit: 1000 });
    for (const run of active) {
      if (this.hostState(run.host) === "unreachable") {
        if (run.state !== "unknown") this.setState(run, { state: "unknown" });
        continue;
      }
      try {
        const s = await this.d.client(run.host).status(run.id);
        const next = decide(run, s, this.d.now(), this.d.idleTimeoutMs);
        const patch: Partial<Run> = {};
        if (next.state !== run.state) patch.state = next.state;
        if (next.idleSince !== run.idleSince) patch.idleSince = next.idleSince;
        if (s.prUrl && s.prUrl !== run.prUrl) patch.prUrl = s.prUrl;
        if (s.progress && JSON.stringify(s.progress) !== JSON.stringify(run.progress)) patch.progress = s.progress;
        if (Object.keys(patch).length) this.setState(run, patch);
      } catch (e: any) {
        this.errorEvent(run.id, e?.code ?? "status_failed", String(e?.message ?? e));
      }
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this.dispatchQueued(); await this.reconcile(); } finally { this.busy = false; }
  }

  start() {
    this.timers.push(setInterval(() => void this.tick(), 5_000), setInterval(() => void this.healthTick(), 15_000));
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
}
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/control && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(control): run decisions and the dispatch/reconcile loop"
```

---

### Task 12: Control HTTP API, auth and terminal WebSocket

**Files:**
- Create: `packages/control/src/server.ts`, `packages/control/src/main.ts`
- Test: `packages/control/src/server.test.ts`

**Interfaces:**
- Consumes: `Store`, `dispatch`, `DispatchError` (Task 10), `ControlLoop` (Task 11), `RunnerClient`, `RunnerCallError`.
- Produces: `createControlApp(deps: { store: Store; loop: ControlLoop; dispatchDeps: DispatchDeps; client: (host: string) => RunnerClient; allowedLogins: string[]; devLogin?: string; uiDir?: string }): Hono` with routes:
  - Auth middleware on `/api/*`: login = header `Tailscale-User-Login`, or `devLogin` when set (dev only); not in `allowedLogins` → `401 {error:{code:"unauthorized"}}`.
  - `GET /api/runs?state=a,b` → `Run[]`; `GET /api/runs/:id` → `{ run, events }`; `GET /api/hosts` → `[{ name, state, active, maxRuns }]`.
  - `POST /api/runs` body `{ project, planPath, host?, agent? }` → `201 Run`; `DispatchError` → `422` (`plan_not_found`) or `400` (other codes).
  - `POST /api/runs/:id/input` body `RunnerInput` → records an `input` event (`source: "user"`, `data: { input, login }`) **before** forwarding; on `RunnerCallError` records an `error` event and returns the runner's status and code.
  - `POST /api/runs/:id/cancel` → runner `cancel`, state `cancelled`; `POST /api/runs/:id/retry` → a new `queued` run with the same project, plan, host and branch (same branch name keeps commits); `POST /api/runs/:id/cleanup` → runner `cleanup` (only for terminal runs, else `409 not_terminal`).
  - `GET /api/runs/:id/screen?lines=N` → proxied text.
  - Static UI from `uiDir` at `/`.
- WebSocket `/api/runs/:id/terminal` (auth by the same header): the server polls the runner screen every 700 ms and sends `{"type":"screen","data":"<ansi text>"}` only when it changed; the client sends `RunnerInput` JSON messages, which follow the same audit path as `POST /input` and reply `{"type":"error","code":...}` on failure. Implemented in `main.ts` with `Bun.serve` `websocket` handlers, because Hono's `app.request` cannot exercise sockets; the audit helper `sendInput(deps, runId, input, login)` lives in `server.ts` and is unit-tested.
- `main.ts` env: `TAC_CONTROL_LISTEN` (default `127.0.0.1:7780`), `TAC_DB` (default `./tac.sqlite`), `TAC_PROJECTS` and `TAC_HOSTS` (paths to the YAML files), `TAC_ALLOWED_LOGINS` (comma list, required), `TAC_DEV_LOGIN` (optional, refused unless the listen address is `127.0.0.1`), `TAC_IDLE_TIMEOUT_MS` (default `900000`), and `TAC_TOKEN_<HOST>` per host.

Retry note: `retry` inserts a new run whose `branch` is the old run's branch. The runner's `addWorktree` checks out the existing branch, so commits are kept (Task 5). The old run must be terminal or `needs_attention`; otherwise `409 not_retryable`.

- [ ] **Step 1: Write the failing test**

`packages/control/src/server.test.ts`:
```ts
import { expect, test } from "bun:test";
import { RunnerCallError } from "./runner-client";
import { createControlApp } from "./server";
import { Store } from "./store";
import { run } from "./store.test";

function setup(inputImpl?: () => Promise<void>) {
  const store = new Store(":memory:");
  const client = () => ({
    input: inputImpl ?? (async () => {}),
    cancel: async () => {}, cleanup: async () => {}, screen: async () => "SCREEN",
    checkPlan: async () => true,
  }) as any;
  const projects = new Map([["p", { name: "p", host: "h1", repoPath: "/r", baseBranch: "main", agent: "claude" as const, agentArgs: [] }]]);
  const hosts = new Map([["h1", { name: "h1", url: "http://x", token: "t", maxRuns: 2 }]]);
  const loop = { hostState: () => "ok" } as any;
  const app = createControlApp({
    store, loop, client, allowedLogins: ["me@x"],
    dispatchDeps: { store, projects, hosts, client, now: () => 1 },
  });
  return { app, store };
}
const H = { "Tailscale-User-Login": "me@x", "content-type": "application/json" };

test("only allowed tailscale logins pass", async () => {
  const { app } = setup();
  expect((await app.request("/api/runs")).status).toBe(401);
  expect((await app.request("/api/runs", { headers: { "Tailscale-User-Login": "other@x" } })).status).toBe(401);
  expect((await app.request("/api/runs", { headers: H })).status).toBe(200);
});

test("dispatch via API", async () => {
  const { app } = setup();
  const r = await app.request("/api/runs", { method: "POST", headers: H, body: JSON.stringify({ project: "p", planPath: "docs/x.md" }) });
  expect(r.status).toBe(201);
  expect((await r.json()).state).toBe("queued");
});

test("input is audited before forwarding, and a rejected input is audited too", async () => {
  const { app, store } = setup(async () => { throw new RunnerCallError(409, "agent_blocked", "blocked"); });
  store.insertRun(run("raaaaaaaa", { state: "running" }));
  const r = await app.request("/api/runs/raaaaaaaa/input", { method: "POST", headers: H, body: JSON.stringify({ type: "prompt", text: "hi" }) });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("agent_blocked");
  const kinds = store.events("raaaaaaaa").map((e) => [e.kind, e.source]);
  expect(kinds).toEqual([["input", "user"], ["error", "control"]]);
  expect(store.events("raaaaaaaa")[0]!.data).toEqual({ input: { type: "prompt", text: "hi" }, login: "me@x" });
});

test("retry reuses the branch; cleanup needs a terminal run", async () => {
  const { app, store } = setup();
  store.insertRun(run("raaaaaaaa", { state: "failed", branch: "run/raaaaaaaa-x" }));
  const r = await (await app.request("/api/runs/raaaaaaaa/retry", { method: "POST", headers: H })).json();
  expect(r.branch).toBe("run/raaaaaaaa-x");
  expect(r.state).toBe("queued");
  store.insertRun(run("rbbbbbbbb", { state: "running" }));
  expect((await app.request("/api/runs/rbbbbbbbb/cleanup", { method: "POST", headers: H })).status).toBe(409);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/control/src/server.test.ts`
Expected: FAIL, cannot find module `./server`.

- [ ] **Step 3: Implement `server.ts`**

```ts
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { newRunId, TERMINAL_STATES, type RunnerInput } from "@tac/shared";
import { dispatch, DispatchError, type DispatchDeps } from "./dispatch";
import type { ControlLoop } from "./loop";
import { RunnerCallError, type RunnerClient } from "./runner-client";
import type { Store } from "./store";

export interface ControlDeps {
  store: Store; loop: Pick<ControlLoop, "hostState">; dispatchDeps: DispatchDeps;
  client: (host: string) => RunnerClient; allowedLogins: string[]; devLogin?: string; uiDir?: string;
}

export const InputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ type: z.literal("keys"), keys: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
]);
const Input = InputSchema;
const DispatchBody = z.object({
  project: z.string(), planPath: z.string().min(1), host: z.string().optional(), agent: z.enum(["claude", "codex"]).optional(),
});
const err = (code: string, message = code) => ({ error: { code, message } });

export function loginOf(d: Pick<ControlDeps, "allowedLogins" | "devLogin">, header: string | undefined): string | null {
  const login = d.devLogin ?? header ?? null;
  return login && d.allowedLogins.includes(login) ? login : null;
}

/** Audit, then forward. Returns null on success or { status, code, message } on failure. */
export async function sendInput(d: ControlDeps, runId: string, input: RunnerInput, login: string) {
  const run = d.store.getRun(runId);
  if (!run) return { status: 404, code: "run_not_found", message: runId };
  d.store.addEvent({ runId, at: Date.now(), kind: "input", source: "user", data: { input, login } });
  try {
    await d.client(run.host).input(runId, input);
    return null;
  } catch (e) {
    const code = e instanceof RunnerCallError ? e.code : "runner_error";
    const status = e instanceof RunnerCallError ? e.status : 502;
    d.store.addEvent({ runId, at: Date.now(), kind: "error", source: "control", data: { code, message: String((e as Error).message) } });
    return { status, code, message: String((e as Error).message) };
  }
}

export function createControlApp(d: ControlDeps) {
  const app = new Hono<{ Variables: { login: string } }>();

  app.onError((e, c) => {
    if (e instanceof z.ZodError) return c.json(err("bad_request", e.message), 400);
    if (e instanceof DispatchError) return c.json(err(e.code, e.message), e.code === "plan_not_found" ? 422 : 400);
    if (e instanceof RunnerCallError) return c.json(err(e.code, e.message), e.status as any);
    return c.json(err("internal", String(e)), 500);
  });

  app.use("/api/*", async (c, next) => {
    const login = loginOf(d, c.req.header("Tailscale-User-Login"));
    if (!login) return c.json(err("unauthorized"), 401);
    c.set("login", login);
    await next();
  });

  const mustRun = (id: string) => {
    const r = d.store.getRun(id);
    if (!r) throw new RunnerCallError(404, "run_not_found", id);
    return r;
  };

  app.get("/api/runs", (c) => {
    const states = c.req.query("state")?.split(",").filter(Boolean) as any;
    return c.json(d.store.listRuns({ states }));
  });
  app.get("/api/runs/:id", (c) => {
    const run = mustRun(c.req.param("id"));
    return c.json({ run, events: d.store.events(run.id) });
  });
  app.get("/api/hosts", (c) => c.json([...d.dispatchDeps.hosts.values()].map((h) => ({
    name: h.name, state: d.loop.hostState(h.name), active: d.store.countActive(h.name), maxRuns: h.maxRuns,
  }))));

  app.post("/api/runs", async (c) => c.json(await dispatch(d.dispatchDeps, DispatchBody.parse(await c.req.json())), 201));

  app.post("/api/runs/:id/input", async (c) => {
    const res = await sendInput(d, c.req.param("id"), Input.parse(await c.req.json()), c.get("login"));
    return res ? c.json(err(res.code, res.message), res.status as any) : c.body(null, 204);
  });

  app.get("/api/runs/:id/screen", async (c) => {
    const run = mustRun(c.req.param("id"));
    return c.text(await d.client(run.host).screen(run.id, Number(c.req.query("lines") ?? 200)));
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const run = mustRun(c.req.param("id"));
    if (run.state !== "queued") await d.client(run.host).cancel(run.id);
    d.store.updateRun(run.id, { state: "cancelled", finishedAt: Date.now() });
    d.store.addEvent({ runId: run.id, at: Date.now(), kind: "state", source: "user", data: { from: run.state, to: "cancelled", login: c.get("login") } });
    return c.body(null, 204);
  });

  app.post("/api/runs/:id/retry", async (c) => {
    const old = mustRun(c.req.param("id"));
    if (!TERMINAL_STATES.includes(old.state) && old.state !== "needs_attention") return c.json(err("not_retryable"), 409);
    // git refuses one branch in two worktrees: free the old worktree first (keeps the branch and its commits)
    try { await d.client(old.host).cleanup(old.id); }
    catch (e) { if (!(e instanceof RunnerCallError && e.code === "run_not_found")) throw e; }
    if (old.state === "needs_attention") d.store.updateRun(old.id, { state: "cancelled", finishedAt: Date.now() });
    const now = Date.now();
    const run = { ...old, id: newRunId(), state: "queued" as const, prUrl: null, progress: null, idleSince: null,
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
    d.store.insertRun(run);
    d.store.addEvent({ runId: run.id, at: now, kind: "dispatch", source: "user", data: { retryOf: old.id, login: c.get("login") } });
    return c.json(run, 201);
  });

  app.post("/api/runs/:id/cleanup", async (c) => {
    const run = mustRun(c.req.param("id"));
    if (!TERMINAL_STATES.includes(run.state)) return c.json(err("not_terminal"), 409);
    await d.client(run.host).cleanup(run.id);
    return c.body(null, 204);
  });

  if (d.uiDir) app.use("/*", serveStatic({ root: d.uiDir }));
  return app;
}
```

Note on `retry`: the retried run has a new `runId` and a new worktree path but the old branch. Git refuses to check out one branch in two worktrees, so the handler cleans up the old run's worktree first (`removeWorktree` keeps the branch and its commits).

- [ ] **Step 4: Implement `main.ts` (wires everything and the WebSocket)**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerInput } from "@tac/shared";
import { loadConfig } from "./config";
import { ControlLoop } from "./loop";
import { HttpRunnerClient, type RunnerClient } from "./runner-client";
import { createControlApp, InputSchema, loginOf, sendInput } from "./server";
import { Store } from "./store";

const env = process.env;
const [hostname, port] = (env.TAC_CONTROL_LISTEN ?? "127.0.0.1:7780").split(":");
if (env.TAC_DEV_LOGIN && hostname !== "127.0.0.1") { console.error("TAC_DEV_LOGIN is only allowed on 127.0.0.1"); process.exit(1); }
const allowedLogins = (env.TAC_ALLOWED_LOGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!allowedLogins.length) { console.error("TAC_ALLOWED_LOGINS is required"); process.exit(1); }

const { projects, hosts } = loadConfig(readFileSync(env.TAC_PROJECTS!, "utf8"), readFileSync(env.TAC_HOSTS!, "utf8"), env);
const store = new Store(env.TAC_DB ?? "./tac.sqlite");
const clients = new Map<string, RunnerClient>([...hosts].map(([n, h]) => [n, new HttpRunnerClient(h)]));
const client = (host: string) => clients.get(host)!;
const loop = new ControlLoop({ store, projects, hosts, client, now: Date.now, idleTimeoutMs: Number(env.TAC_IDLE_TIMEOUT_MS ?? 900_000) });
const deps = {
  store, loop, client, allowedLogins, devLogin: env.TAC_DEV_LOGIN,
  uiDir: join(import.meta.dir, "../dist/ui"),
  dispatchDeps: { store, projects, hosts, client, now: Date.now },
};
const app = createControlApp(deps);

type WsData = { runId: string; login: string; timer?: ReturnType<typeof setInterval>; last?: string };

Bun.serve<WsData>({
  hostname, port: Number(port),
  fetch(req, server) {
    const m = new URL(req.url).pathname.match(/^\/api\/runs\/(r[a-z0-9]{8})\/terminal$/);
    if (m) {
      const login = loginOf(deps, req.headers.get("Tailscale-User-Login") ?? undefined);
      if (!login) return new Response("unauthorized", { status: 401 });
      if (!store.getRun(m[1]!)) return new Response("not found", { status: 404 });
      return server.upgrade(req, { data: { runId: m[1]!, login } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const poll = async () => {
        const run = store.getRun(ws.data.runId);
        if (!run) return;
        try {
          const screen = await client(run.host).screen(run.id, 200);
          if (screen !== ws.data.last) { ws.data.last = screen; ws.send(JSON.stringify({ type: "screen", data: screen })); }
        } catch (e: any) { ws.send(JSON.stringify({ type: "error", code: e?.code ?? "screen_failed" })); }
      };
      void poll();
      ws.data.timer = setInterval(() => void poll(), 700);
    },
    async message(ws, msg) {
      let parsed: unknown;
      try { parsed = JSON.parse(String(msg)); } catch { parsed = null; }
      const input = InputSchema.safeParse(parsed);
      if (!input.success) { ws.send(JSON.stringify({ type: "error", code: "bad_request" })); return; }
      const res = await sendInput(deps, ws.data.runId, input.data as RunnerInput, ws.data.login);
      if (res) ws.send(JSON.stringify({ type: "error", code: res.code, message: res.message }));
    },
    close(ws) { if (ws.data.timer) clearInterval(ws.data.timer); },
  },
});

loop.start();
console.log(`tac-control listening on ${hostname}:${port}`);
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/control && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(control): API with tailscale auth, audited input and terminal websocket"
```

---

### Task 13: Minimal UI (run list and terminal)

**Files:**
- Create: `packages/control/ui/index.html`, `packages/control/ui/main.tsx`, `packages/control/ui/api.ts`
- Modify: `packages/control/package.json` (add `react@^18.3.0`, `react-dom@^18.3.0`, `@xterm/xterm@^5.5.0`, dev `@types/react`, `@types/react-dom`; script `"build:ui": "bun build ui/main.tsx --outdir dist/ui --minify && cp ui/index.html dist/ui/ && cp node_modules/@xterm/xterm/css/xterm.css dist/ui/"`)
- Test: `packages/control/ui/api.test.ts`

**Interfaces:**
- Consumes: control API from Task 12 (`GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/{cancel,retry}`, WS `/api/runs/:id/terminal`).
- Produces: `stateColor(state: RunState): string`; `progressLabel(p: PlanProgress | null): string` (`"3/10"` or `"-"`); `keyFor(e: { key: string; ctrlKey: boolean }): string | null` mapping browser keys to herdr key names (`Enter`→`enter`, `Escape`→`esc`, `ArrowUp`→`up`, `ArrowDown`→`down`, `ArrowLeft`→`left`, `ArrowRight`→`right`, `Tab`→`tab`, `Backspace`→`backspace`, ctrl+letter→`ctrl+<letter>`; printable single characters return `null` because they go as `text`).

UI behavior (mobile-first, single page, no router):
- List view: polls `GET /api/runs` every 3 s; each row shows project, state (colored badge), progress label, host, age, PR link. Runs in `waiting_input` sort first.
- Detail view (click a row): xterm.js terminal (read-only rendering of `screen` messages: `term.reset(); term.write(data)`), a text box plus "Send" button (sends `{type:"prompt"}`), a key bar with buttons `↑ ↓ Enter Esc y n Ctrl+C` (sends `keys`, or `text` for `y`/`n`), buttons Cancel and Retry, and the event list. Keyboard input on the terminal uses `keyFor`: mapped keys go as `keys`, printable characters as `text`.
- Errors from the WebSocket show as a red banner with the code.

- [ ] **Step 1: Write the failing test for the pure helpers**

`packages/control/ui/api.test.ts`:
```ts
import { expect, test } from "bun:test";
import { keyFor, progressLabel, stateColor } from "./api";

test("key mapping", () => {
  expect(keyFor({ key: "Enter", ctrlKey: false })).toBe("enter");
  expect(keyFor({ key: "ArrowDown", ctrlKey: false })).toBe("down");
  expect(keyFor({ key: "c", ctrlKey: true })).toBe("ctrl+c");
  expect(keyFor({ key: "y", ctrlKey: false })).toBeNull();
});

test("labels", () => {
  expect(progressLabel(null)).toBe("-");
  expect(progressLabel({ waves: [], done: 3, total: 10 })).toBe("3/10");
  expect(stateColor("waiting_input")).toBe("#d97706");
  expect(stateColor("failed")).toBe("#dc2626");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/control/ui/api.test.ts`
Expected: FAIL, cannot find module `./api`.

- [ ] **Step 3: Implement `api.ts`**

```ts
import type { PlanProgress, RunState } from "@tac/shared";

const COLORS: Record<RunState, string> = {
  queued: "#6b7280", preparing: "#2563eb", running: "#2563eb", waiting_input: "#d97706", finishing: "#7c3aed",
  succeeded: "#16a34a", needs_attention: "#d97706", failed: "#dc2626", cancelled: "#6b7280", unknown: "#9ca3af",
};
export const stateColor = (s: RunState) => COLORS[s];
export const progressLabel = (p: PlanProgress | null) => (p && p.total ? `${p.done}/${p.total}` : "-");

const KEYS: Record<string, string> = {
  Enter: "enter", Escape: "esc", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Tab: "tab", Backspace: "backspace",
};
export function keyFor(e: { key: string; ctrlKey: boolean }): string | null {
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return `ctrl+${e.key.toLowerCase()}`;
  return KEYS[e.key] ?? null;
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.code ?? `http_${r.status}`);
  return r.json() as Promise<T>;
}
export async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.code ?? `http_${r.status}`);
}
```

- [ ] **Step 4: Implement `index.html` and `main.tsx`**

`packages/control/ui/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>tac</title>
  <link rel="stylesheet" href="/xterm.css" />
  <style>
    :root { color-scheme: light dark; --bg: #fff; --fg: #111; --muted: #6b7280; --line: #e5e7eb; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0b0b0c; --fg: #e5e7eb; --muted: #9ca3af; --line: #26272b; } }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.4 system-ui, sans-serif; }
    main { max-width: 1100px; margin: 0 auto; padding: 12px 16px; }
    .row { display: flex; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); cursor: pointer; flex-wrap: wrap; }
    .badge { color: #fff; border-radius: 6px; padding: 2px 8px; font-size: 13px; }
    .muted { color: var(--muted); font-size: 13px; }
    .bar { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; }
    input { font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); flex: 1; min-width: 0; background: transparent; color: inherit; }
    .err { background: #dc2626; color: #fff; padding: 6px 10px; border-radius: 8px; }
    #term { width: 100%; height: 60vh; }
  </style>
</head>
<body><main id="root"></main><script type="module" src="/main.js"></script></body>
</html>
```

`packages/control/ui/main.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import type { Run, RunEvent, RunnerInput } from "@tac/shared";
import { getJson, keyFor, post, progressLabel, stateColor } from "./api";

function age(ms: number) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function RunList({ onOpen }: { onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    const load = () => getJson<Run[]>("/api/runs").then(setRuns).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  const sorted = [...runs].sort((a, b) => Number(b.state === "waiting_input") - Number(a.state === "waiting_input"));
  return (
    <div>
      <h2>Runs</h2>
      {sorted.map((r) => (
        <div key={r.id} className="row" onClick={() => onOpen(r.id)}>
          <span className="badge" style={{ background: stateColor(r.state) }}>{r.state}</span>
          <strong>{r.project}</strong>
          <span className="muted">{r.planPath.split("/").pop()}</span>
          <span className="muted">{progressLabel(r.progress)}</span>
          <span className="muted">{r.host} · {age(r.createdAt)}</span>
          {r.prUrl && <a href={r.prUrl} target="_blank" onClick={(e) => e.stopPropagation()}>PR</a>}
        </div>
      ))}
    </div>
  );
}

function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const termEl = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const [data, setData] = useState<{ run: Run; events: RunEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const send = (input: RunnerInput) => ws.current?.send(JSON.stringify(input));

  useEffect(() => {
    const load = () => getJson<{ run: Run; events: RunEvent[] }>(`/api/runs/${id}`).then(setData).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 3000);
    const term = new Terminal({ convertEol: true, fontSize: 13, scrollback: 2000 });
    term.open(termEl.current!);
    term.onKey(({ domEvent }) => {
      const k = keyFor(domEvent);
      if (k) send({ type: "keys", keys: [k] });
      else if (domEvent.key.length === 1) send({ type: "text", text: domEvent.key });
    });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws.current = new WebSocket(`${proto}://${location.host}/api/runs/${id}/terminal`);
    ws.current.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "screen") { term.reset(); term.write(msg.data); setError(null); }
      if (msg.type === "error") setError(msg.code);
    };
    return () => { clearInterval(t); ws.current?.close(); term.dispose(); };
  }, [id]);

  const act = (path: string) => post(`/api/runs/${id}/${path}`).catch((e) => setError(e.message));

  return (
    <div>
      <div className="bar"><button onClick={onBack}>← Runs</button>
        {data && <span className="badge" style={{ background: stateColor(data.run.state) }}>{data.run.state}</span>}
        {data && <strong>{data.run.project}</strong>}
        {data && <span className="muted">{progressLabel(data.run.progress)}</span>}
        {data?.run.prUrl && <a href={data.run.prUrl} target="_blank">PR</a>}
      </div>
      {error && <div className="err">{error}</div>}
      <div id="term" ref={termEl} />
      <div className="bar">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message to the agent" />
        <button onClick={() => { if (text) { send({ type: "prompt", text }); setText(""); } }}>Send</button>
      </div>
      <div className="bar">
        {["up", "down", "enter", "esc", "ctrl+c"].map((k) => <button key={k} onClick={() => send({ type: "keys", keys: [k] })}>{k}</button>)}
        {["y", "n"].map((k) => <button key={k} onClick={() => send({ type: "text", text: k })}>{k}</button>)}
        <button onClick={() => act("cancel")}>Cancel</button>
        <button onClick={() => act("retry")}>Retry</button>
      </div>
      <h3>Events</h3>
      {data?.events.slice().reverse().map((e, i) => (
        <div key={i} className="muted">{new Date(e.at).toLocaleTimeString()} {e.kind} {e.source} {JSON.stringify(e.data)}</div>
      ))}
    </div>
  );
}

function App() {
  const [open, setOpen] = useState<string | null>(null);
  return open ? <RunDetail id={open} onBack={() => setOpen(null)} /> : <RunList onOpen={setOpen} />;
}

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 5: Run tests and build**

Run: `cd packages/control && bun add react@^18.3.0 react-dom@^18.3.0 @xterm/xterm@^5.5.0 && bun add -d @types/react @types/react-dom && bun run build:ui && cd ../.. && bun test packages/control && bun run typecheck && ls packages/control/dist/ui`
Expected: tests pass; `dist/ui` has `index.html`, `main.js`, `xterm.css`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(control): minimal mobile run list and live terminal UI"
```

---

### Task 14: `tac` CLI

**Files:**
- Create: `packages/cli/src/tac.ts`, `packages/cli/src/args.ts`
- Modify: `packages/cli/package.json` (`"bin": { "tac": "src/tac.ts" }`)
- Test: `packages/cli/src/args.test.ts`

**Interfaces:**
- Consumes: control API (Task 12).
- Produces: `parseArgs(argv: string[]): Command` where
  `type Command = { cmd: "dispatch"; project: string; planPath: string; host?: string; agent?: "claude" | "codex" } | { cmd: "ls"; all: boolean } | { cmd: "show" | "cancel" | "retry" | "cleanup" | "open-pr" | "screen"; runId: string } | { cmd: "send"; runId: string; text: string } | { cmd: "help" }`.
- Config: `TAC_URL` env or `~/.config/tac/config.json` `{ "url": "https://agent-control.tail39ebd.ts.net" }`. Requests go through Tailscale Serve, which adds the identity header; for local dev `TAC_URL=http://127.0.0.1:7780` with `TAC_DEV_LOGIN` on the server.
- Output: `ls` prints one line per run: `<id>  <state padded 16>  <progress>  <project>  <plan file>  <PR url or ->`; `ls` without `--all` hides terminal runs older than 24 h. `dispatch` prints the run id. `open-pr` runs `open <url>` on macOS. Errors print `error: <code>: <message>` and exit 1.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/args.test.ts`:
```ts
import { expect, test } from "bun:test";
import { parseArgs } from "./args";

test("dispatch with options", () => {
  expect(parseArgs(["dispatch", "leiloes_veiculos", "docs/p.md", "--host", "devbox-htz", "--agent", "codex"]))
    .toEqual({ cmd: "dispatch", project: "leiloes_veiculos", planPath: "docs/p.md", host: "devbox-htz", agent: "codex" });
});

test("simple commands", () => {
  expect(parseArgs(["ls"])).toEqual({ cmd: "ls", all: false });
  expect(parseArgs(["ls", "--all"])).toEqual({ cmd: "ls", all: true });
  expect(parseArgs(["cancel", "raaaaaaaa"])).toEqual({ cmd: "cancel", runId: "raaaaaaaa" });
  expect(parseArgs(["send", "raaaaaaaa", "continue", "please"])).toEqual({ cmd: "send", runId: "raaaaaaaa", text: "continue please" });
});

test("bad input gives help", () => {
  expect(parseArgs([])).toEqual({ cmd: "help" });
  expect(parseArgs(["dispatch", "x"])).toEqual({ cmd: "help" });
  expect(parseArgs(["cancel"])).toEqual({ cmd: "help" });
  expect(parseArgs(["dispatch", "p", "x.md", "--agent", "gpt"])).toEqual({ cmd: "help" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli`
Expected: FAIL, cannot find module `./args`.

- [ ] **Step 3: Implement `args.ts`**

```ts
export type Command =
  | { cmd: "dispatch"; project: string; planPath: string; host?: string; agent?: "claude" | "codex" }
  | { cmd: "ls"; all: boolean }
  | { cmd: "show" | "cancel" | "retry" | "cleanup" | "open-pr" | "screen"; runId: string }
  | { cmd: "send"; runId: string; text: string }
  | { cmd: "help" };

const ONE_ID = ["show", "cancel", "retry", "cleanup", "open-pr", "screen"] as const;

export function parseArgs(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  if (cmd === "ls") return { cmd: "ls", all: rest.includes("--all") };
  if (cmd === "dispatch") {
    const pos: string[] = [];
    const opts: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("--")) { const v = rest[++i]; if (!v) return { cmd: "help" }; opts[a.slice(2)] = v; }
      else pos.push(a);
    }
    if (pos.length !== 2) return { cmd: "help" };
    if (opts.agent && opts.agent !== "claude" && opts.agent !== "codex") return { cmd: "help" };
    return { cmd: "dispatch", project: pos[0]!, planPath: pos[1]!,
      ...(opts.host ? { host: opts.host } : {}), ...(opts.agent ? { agent: opts.agent as "claude" | "codex" } : {}) };
  }
  if (cmd === "send" && rest.length >= 2) return { cmd: "send", runId: rest[0]!, text: rest.slice(1).join(" ") };
  if ((ONE_ID as readonly string[]).includes(cmd ?? "") && rest.length === 1)
    return { cmd: cmd as (typeof ONE_ID)[number], runId: rest[0]! };
  return { cmd: "help" };
}
```

- [ ] **Step 4: Implement `tac.ts`**

```ts
#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Run, RunEvent } from "@tac/shared";
import { parseArgs } from "./args";

const HELP = `usage:
  tac dispatch <project> <plan-path> [--host auto|<host>] [--agent claude|codex]
  tac ls [--all]
  tac show <run>      tac screen <run>     tac send <run> <text...>
  tac cancel <run>    tac retry <run>      tac cleanup <run>    tac open-pr <run>`;

function baseUrl(): string {
  if (process.env.TAC_URL) return process.env.TAC_URL;
  const f = join(homedir(), ".config/tac/config.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")).url;
  console.error("set TAC_URL or ~/.config/tac/config.json"); process.exit(1);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${baseUrl()}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    console.error(`error: ${j?.error?.code ?? r.status}: ${j?.error?.message ?? r.statusText}`);
    process.exit(1);
  }
  const ct = r.headers.get("content-type") ?? "";
  return r.status === 204 ? null : ct.includes("json") ? r.json() : r.text();
}

const line = (r: Run) => [
  r.id, r.state.padEnd(16), (r.progress?.total ? `${r.progress.done}/${r.progress.total}` : "-").padEnd(6),
  r.project, r.planPath.split("/").pop(), r.prUrl ?? "-",
].join("  ");

const c = parseArgs(process.argv.slice(2));
switch (c.cmd) {
  case "dispatch": {
    const r: Run = await api("POST", "/api/runs", { project: c.project, planPath: c.planPath, host: c.host, agent: c.agent });
    console.log(r.id);
    break;
  }
  case "ls": {
    const runs: Run[] = await api("GET", "/api/runs");
    const cutoff = Date.now() - 86_400_000;
    for (const r of runs) if (c.all || !["succeeded", "failed", "cancelled"].includes(r.state) || r.updatedAt > cutoff) console.log(line(r));
    break;
  }
  case "show": {
    const { run, events }: { run: Run; events: RunEvent[] } = await api("GET", `/api/runs/${c.runId}`);
    console.log(line(run));
    for (const e of events) console.log(`${new Date(e.at).toISOString()}  ${e.kind}  ${e.source}  ${JSON.stringify(e.data)}`);
    break;
  }
  case "screen": console.log(await api("GET", `/api/runs/${c.runId}/screen?lines=200`)); break;
  case "send": await api("POST", `/api/runs/${c.runId}/input`, { type: "prompt", text: c.text }); break;
  case "cancel": case "cleanup": await api("POST", `/api/runs/${c.runId}/${c.cmd}`); break;
  case "retry": console.log((await api("POST", `/api/runs/${c.runId}/retry`)).id); break;
  case "open-pr": {
    const { run }: { run: Run } = await api("GET", `/api/runs/${c.runId}`);
    if (!run.prUrl) { console.error("error: no_pr: this run has no PR yet"); process.exit(1); }
    Bun.spawn(["open", run.prUrl]);
    break;
  }
  default: console.log(HELP); if (process.argv.length > 2) process.exit(1);
}
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/cli && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cli): tac command-line client"
```

---

### Task 15: Operations doc and end-to-end run on devbox-homelab

**Files:**
- Create: `docs/operations.md`, `examples/projects.yaml`, `examples/hosts.yaml`, `scripts/e2e-homelab.sh`

**Interfaces:**
- Consumes: everything above.
- Produces: a documented manual setup (until the `infra` plan automates it) and a verified end-to-end run.

This task touches real machines. It installs nothing system-wide: the runner is a compiled binary in `~/.local/bin` started by hand, and `control` runs on the Mac on `127.0.0.1`.

- [ ] **Step 1: Write `examples/projects.yaml` and `examples/hosts.yaml`**

```yaml
# examples/projects.yaml
projects:
  tac-e2e:
    host: devbox-homelab
    repoPath: /home/apretto/workspace/tac-e2e
    baseBranch: main
    agent: claude
    agentArgs: ["--model", "haiku"]
```

```yaml
# examples/hosts.yaml
hosts:
  devbox-homelab:
    url: http://devbox-homelab.tail39ebd.ts.net:7781
    maxRuns: 2
```

- [ ] **Step 2: Write `docs/operations.md`**

Content (write it out in full):
1. Build: `bun install && (cd packages/runner && bun run build) && (cd packages/control && bun run build:ui)`.
2. Runner on a devbox: `scp packages/runner/dist/tac-runner <host>:~/.local/bin/`; generate a token with `openssl rand -hex 32`; start with `TAC_RUNNER_TOKEN=<token> TAC_RUNNER_LISTEN=<tailnet-ip>:7781 ~/.local/bin/tac-runner`, where `<tailnet-ip>` comes from `tailscale ip -4` on the devbox. Until the `infra` plan adds the Tailscale ACL, note that any tailnet node can reach the port, so the token is the only guard.
3. Control locally: `TAC_PROJECTS=examples/projects.yaml TAC_HOSTS=examples/hosts.yaml TAC_TOKEN_DEVBOX_HOMELAB=<token> TAC_ALLOWED_LOGINS=dev TAC_DEV_LOGIN=dev bun packages/control/src/main.ts`, then open `http://127.0.0.1:7780`.
4. CLI: `TAC_URL=http://127.0.0.1:7780 bun packages/cli/src/tac.ts ls`.
5. Claude Code's folder trust dialog: every new worktree shows it once. The run sits in `waiting_input`; answer it from the UI (`down`, `enter`). The initial prompt is sent automatically once the agent becomes idle.
6. Cleanup: `tac cleanup <run>` after the PR is merged or closed.

- [ ] **Step 3: Create the test repo on devbox-homelab**

Run (from the Mac):
```bash
gh repo create tac-e2e --private --clone=false
ssh devbox-homelab 'cd ~/workspace && gh repo clone tac-e2e && cd tac-e2e && mkdir -p docs/superpowers/plans && cat > docs/superpowers/plans/2026-10-15-hello.md <<EOF
# Hello Plan
## Wave 1
### Task 1: hello file
- [ ] **Step 1:** Create hello.txt containing the word hello.
- [ ] **Step 2:** Commit it with message "feat: hello".
EOF
git add . && git commit -m "docs: hello plan" && git push -u origin HEAD:main'
```
Expected: the repo exists on GitHub with the plan on `main`.

Ask the user before running `gh repo create`: it creates a repository on their GitHub account.

- [ ] **Step 4: Start the runner and control, then dispatch**

Write `scripts/e2e-homelab.sh` that prints each command it runs and does: start control locally (Step 2 item 3) in the background, wait for `GET /api/hosts` to show `devbox-homelab` as `ok`, run `tac dispatch tac-e2e docs/superpowers/plans/2026-10-15-hello.md`, then poll `tac show <run>` every 10 s for up to 15 minutes, printing each state change.

Run: `bash scripts/e2e-homelab.sh`
Expected sequence of states: `queued → preparing → waiting_input` (trust dialog). Answer it from the UI at `http://127.0.0.1:7780` (`down`, `enter`), then: `running → finishing → succeeded`, with a PR URL. Check by hand: the PR exists, `hello.txt` is in it, and `run_events` lists the two key inputs with login `dev`.

- [ ] **Step 5: Check the review-focus failure modes by hand**

1. `tac dispatch tac-e2e docs/superpowers/plans/missing.md` → `error: plan_not_found: ...`, and `tac ls --all` shows no new run.
2. During a second run, stop the runner (Ctrl+C) for 60 s and start it again → the run shows `unknown` while the host is unreachable and returns to its previous state after; it never shows `failed`.
3. Dispatch the hello plan twice in a row → two runs, two worktrees under `~/worktrees/tac-e2e/`, two branches.

Record the outcome of each check in `docs/operations.md` under "E2E results (2026-10-15)".

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: operations guide and homelab e2e"
```
