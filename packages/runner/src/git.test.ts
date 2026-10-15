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

test("a new run branch has no upstream, so git never suggests pushing to the base branch", async () => {
  const w = join(root, "wt/rd");
  await git.addWorktree(clone, w, "run/rd-p", "main");
  const r = await realExec(["git", "rev-parse", "--abbrev-ref", "run/rd-p@{upstream}"], { cwd: w });
  expect(r.code).not.toBe(0);
});
