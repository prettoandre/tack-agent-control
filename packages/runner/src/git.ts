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
    else await this.ok(repoPath, ["worktree", "add", "--no-track", "-b", branch, worktreePath, `origin/${baseBranch}`]);
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
