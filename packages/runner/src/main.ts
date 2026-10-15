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
