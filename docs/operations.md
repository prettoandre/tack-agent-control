# Operations guide

Manual setup until the `infra` plan automates it. Nothing is installed system-wide: the runner is a compiled
binary in `~/.local/bin` started by hand, and `control` runs on the Mac on loopback.

## 1. Build

```bash
bun install && (cd packages/runner && bun run build) && (cd packages/control && bun run build:ui)
```

## 2. Runner on a devbox

```bash
scp packages/runner/dist/tac-runner <host>:~/.local/bin/
openssl rand -hex 32            # the token; keep it in a chmod 600 file, never commit it
tailscale ip -4                 # on the devbox: the <tailnet-ip>
TAC_RUNNER_TOKEN=<token> TAC_RUNNER_LISTEN=<tailnet-ip>:7781 ~/.local/bin/tac-runner
```

Notes:

- Until the `infra` plan adds the Tailscale ACL, any tailnet node can reach the port, so the token is the only guard.
- The runner needs `herdr`, `git`, `gh` and the agent CLI (`claude`) on its `PATH`. When started detached with
  `setsid nohup`, export `PATH=$HOME/.local/bin:$PATH` first.
- Dedicated herdr session: set `TAC_HERDR_SESSION=<name>` and start `herdr --session <name> server` first. Never
  point the runner at a session you use interactively; never stop a server without `--session <name>`.
- `POST /runs` answers once the worktree, tab and state file exist and launches the agent in the background
  (the server uses `idleTimeout: 120` because `git fetch` and `worktree add` run inside the request).
- Run branches are created with `--no-track`.
- Worktrees live under `~/worktrees/<project>/<run>`; state files under `~/.local/state/tac-runner/runs`.
- Redeploy: copy the new binary next to the old one, stop the runner with `SIGTERM` (its pid file), move the binary
  into place and start it again with the same environment. Runs survive the restart: their state files are reloaded.
- `hosts.yaml` URLs use the tailnet (MagicDNS) name of the machine, which can differ from your SSH alias
  (here the SSH alias `devbox-homelab` is the tailnet node `devbox-local`).

## 3. Control locally

```bash
TAC_PROJECTS=examples/projects.yaml TAC_HOSTS=examples/hosts.yaml TAC_TOKEN_DEVBOX_HOMELAB=<token> \
TAC_ALLOWED_LOGINS=dev TAC_DEV_LOGIN=dev bun packages/control/src/main.ts
```

Then open `http://127.0.0.1:7780`.

- `TAC_CONTROL_LISTEN` (default `127.0.0.1:7780`) must be a loopback address; control exits otherwise, because it
  trusts the `Tailscale-User-Login` header and must only be reachable through Tailscale Serve.
- Every `/api` request and the terminal WebSocket upgrade pass a Host allowlist (`127.0.0.1:<port>`,
  `localhost:<port>`, `[::1]:<port>`, plus the comma list `TAC_PUBLIC_HOSTS`) and an Origin check. `POST` requests
  must send `content-type: application/json`.
- `TAC_DEV_LOGIN` is only honoured on `127.0.0.1`. `TAC_DB` sets the sqlite path (default `./tac.sqlite`).

### Behind Tailscale Serve (verified 2026-10-15)

Run `tailscale serve <port>` in the foreground (not `--bg`). A header-echo server behind
`tailscale serve 17999`, requested at `https://andr-mbp.tail39ebd.ts.net/`, received:

| Header | Value |
|---|---|
| `Host` | `andr-mbp.tail39ebd.ts.net` (no port) |
| `X-Forwarded-Host` | `andr-mbp.tail39ebd.ts.net` |
| `X-Forwarded-Proto` | `https` |
| `Tailscale-User-Login` | the caller's login |

So set `TAC_PUBLIC_HOSTS=<mac>.<tailnet>.ts.net` (host only, no port) when using Serve. The first HTTPS request
can take about 30 s while the certificate is provisioned.

## 4. CLI

```bash
TAC_URL=http://127.0.0.1:7780 bun packages/cli/src/tac.ts ls
```

## 5. Claude Code's folder trust dialog

Only the first run in a folder Claude Code does not trust yet shows it; later runs of the same project started without
it in this e2e. The run sits in `waiting_input`. Answer it from the UI: use `up`/`down` until the cursor is on
"Yes, I trust this folder" as shown on the screen, then `enter`. The initial prompt follows automatically once the
agent is idle (see "Initial prompt delivery").

## Initial prompt delivery

Control builds the prompt: `Execute the plan at <plan> using the superpowers:subagent-driven-development skill. When
all tasks are done, open a pull request from the current branch. As you complete each step, mark its checkbox in the
plan file as done (change "- [ ]" to "- [x]") and commit the plan file with your work.` The last sentence makes the
plan checkboxes a progress source until the Claude hooks source exists.

The runner delivers it, and only from the status poll (control polls every 5 s):

- Starting the agent never sends the prompt. The first poll that sees the agent idle after the launch sends it and
  reports the agent as `working` for that poll. A trust dialog (agent `blocked`) simply delays this poll.
- The prompt counts as acknowledged when the agent is seen `working` or `blocked`, or when the PR URL, the number of
  ticked boxes or the branch head differ from what they were when the prompt first went out (a retried run keeps its
  branch, so an old PR or old ticks do not count).
- While it is not acknowledged and the agent is idle, the runner retries at least 4 s after the previous attempt, at
  most 3 attempts in total including the first send. Each retry reads the pane first: the prompt still in the input box
  (typed, not submitted) gets `enter`; a prompt that is not on screen is sent again; a prompt already in the transcript
  above the input box counts as delivered. `enter` is never pressed when the prompt text is not in the input box, so
  a dialog option or a suggested prompt is never selected by accident.
- Control only sees `promptSent: true` once the prompt is acknowledged or the 3 attempts are spent; until then an idle
  agent does not start the idle timer. A herdr error during an attempt is logged and the attempt still counts;
  `agent_blocked` does not count.

## 6. Cleanup

`tac cleanup <run>` after the PR is merged or closed. It only accepts terminal runs (`succeeded`, `failed`,
`cancelled`); for any other state it answers `409 not_terminal`, so `tac cancel <run>` first. It removes the worktree
and tab; the local `run/...` branch is left in the repo.

## herdr and text that starts with `-` (verified on herdr 0.9.3)

`herdr pane send-text`, `agent prompt` and `agent send-keys` accept values that start with `-` as they are.
A `--` separator is not supported for them: `pane send-text <pane> -- "x"` types the literal `--` first, and
`agent prompt <name> -- -x` fails with `unknown option: -x`. The runner therefore passes user text without `--`.

## E2E setup used (2026-10-15)

`scripts/e2e-homelab.sh` (reads the token from `TAC_E2E_TOKEN_FILE`) reuses a control already listening on
`127.0.0.1:7780`, or starts one, waits for the host to be `ok`, dispatches the hello plan of the private repo
`tack-e2e` and polls `tac show` every 10 s for up to 15 minutes.

## E2E results (2026-10-15)

The test repository was renamed from `prettoandre/tac-e2e` to `prettoandre/tack-e2e` on 2026-10-16; the
records below keep the names used at the time. PR #2 and the remote `run/*` branches were closed and deleted then.

Setup: control on the Mac (`127.0.0.1:7780`, dev login), runner on devbox-homelab (`devbox-local` on the tailnet)
with a dedicated herdr session `tac-e2e`, private repo `prettoandre/tac-e2e` with the hello plan on `main`.

| Check | Result |
|---|---|
| Hello plan, project `tac-e2e` (haiku) | `queued -> preparing -> waiting_input` (trust dialog) as expected. After the dialog, see the prompt-delivery defect below. Final: `succeeded`, PR #1 `run/r64tc7bsj-hello`, one commit "feat: hello", file `hello.txt` containing `hello`. `run_events` lists every key and prompt input with login `dev`. |
| Empty `agentArgs` (R28), project `tac-e2e-noargs` | Agent started, reached `waiting_input`, no herdr argv error. Cancelled and cleaned up. |
| Tailscale Serve headers (R29) | See "Behind Tailscale Serve": `Host` and `X-Forwarded-Host` are the bare MagicDNS name, so `TAC_PUBLIC_HOSTS=<mac>.<tailnet>.ts.net`. |
| herdr `--` (R30) | Not supported and harmful; the runner passes text without it. See above. |
| Check 1: missing plan | `tac dispatch tac-e2e docs/superpowers/plans/missing.md` printed `error: plan_not_found: ... is not on origin/main; commit and push it first`; `tac ls --all` showed no new run. |
| Check 2: runner down about 60 s while two runs were active | Runner stopped at 20:09:07 and restarted at 20:10:16. The runs went `finishing -> unknown` (after the host was marked unreachable) and returned to `finishing` as soon as the runner was back. Never `failed`. A third run dispatched meanwhile stayed `queued`, but because both `maxRuns` slots were taken, so this check does not show how an unreachable host holds back dispatch. The earlier redeploy (a few seconds of downtime) logged one `ECONNREFUSED` error event and no state change beyond the normal ones. |
| Check 3: two dispatches in a row | Two runs, two worktrees (`~/worktrees/tac-e2e/<run>`), two branches (`run/<run>-hello`). No trust dialog appeared because the folder was already trusted in the earlier session. Both went `running -> finishing` within 20-30 s with `0/2` and no PR: they were dispatched at 20:07:13, after PR #1 had been merged into `main` at 20:06:55, so the plan was already done and there was nothing to propose (see "Fresh dispatches after PR #1"). |
| `scripts/e2e-homelab.sh`, first run | `TAC_E2E_TIMEOUT_S=45` against the already running control: reused control, host `ok`, dispatched, printed `queued -> preparing -> running`, then timed out as configured. That run also started after PR #1 was merged and went `running -> finishing` in 30 s without a PR. Cancelled and cleaned up. |
| Pane-checked delivery and checkbox prompt (after commits 1daa07a, 2a4f200) | Runner and control redeployed, then `scripts/e2e-homelab.sh` with `TAC_E2E_TIMEOUT_S=60`: reused control, host `ok`, run `r63agm9er` `queued -> preparing -> running -> succeeded` in 47 s, script exit 0. State file: the prompt went out on the first idle poll (`promptAttempts: 1`) and was acknowledged by the agent being seen `working`; no retry was needed. The pane shows the full prompt, including the checkbox sentence, as submitted. The agent ticked both boxes (progress `2/2`), committed the plan file and opened PR #2. Cleaned up; PR #2 left open. |

### Fresh dispatches after PR #1

A review suspected that these quick `running -> finishing` runs had lost their initial prompt. A fresh dispatch on the
old runner (run `rqzrccjx0`, before the delivery change) disproved it: 3 s after `running` the pane showed the prompt
submitted and the agent working, and the state file had `promptAcked: true, nudgeCount: 0`. The agent found `hello.txt`
and the `feat: hello` commit already on `main`, ran `gh pr create`, which failed with "No commits between main and
run/rqzrccjx0-hello", pushed the run branch, and stopped 25 s after `running`. So with the old prompt, a plan that is
already done ends in `finishing` without a PR, then `needs_attention`. With the checkbox sentence the agent commits the
ticked plan, so the same plan now ends in a PR (run `r63agm9er` above).

### Prompt-delivery defect and fix (R33)

After the trust dialog was answered, the deferred plan prompt was typed into Claude's input box but never submitted
(the pane showed `❯ Execute the plan at ...` with no response, the run drifted `running -> finishing`). Commit 9f0ff0e
made the runner track `promptAcked` and nudge with `enter` up to 3 times, at least 5 s apart. After redeploying the
runner, the nudge submitted the stuck prompt, the agent started working and the run reached `succeeded`. The runner
restart itself did not fail the run. Commit 1daa07a replaced the blind nudge with the pane-checked delivery described
in "Initial prompt delivery".

### Findings

- Checkbox progress stayed `0/2` for the whole run: the agent never ticked the plan checkboxes, because the prompt did
  not ask for it. The prompt now does, and run `r63agm9er` reached `2/2`. Progress still depends on the agent
  following the instruction, so do not use it as a completion signal until the Claude hooks source exists.
- Input after `succeeded` is accepted: control forwarded and recorded four prompts ("ok, siga", "faça a revisão
  final", "pode fazer o merge", "pode apagar, se tudo esta margeado e enviado para o remoto") sent into the still-alive
  session. That is consistent with the spec (the session lives
  until cleanup) and useful for follow-up, but nothing marks the run as active again, so the UI still shows
  `succeeded` while the agent works (here the agent merged PR #1). Recommendation: when input is accepted for a
  terminal run, show a warning in the UI, and/or move the run back to `running` so the loop tracks the agent again.
- Runs block on reading Claude Code plugin skill files outside the worktree (`~/.claude/plugins/...`), which shows a
  permission prompt and puts the run in `waiting_input`. Follow-up: write per-run Claude settings that allow those
  reads (`permissions.additionalDirectories` or a `Read(~/.claude/plugins/**)` allow rule).
- A text prompt sent while the agent is blocked returns `agent_blocked`. Use the key bar (`down`, `enter`, ...) in the
  UI to answer prompts.
- A run whose agent stops without a PR stays `finishing` and becomes `needs_attention` after the idle timeout
  (`TAC_IDLE_TIMEOUT_MS`, default 15 minutes). Both states are active and occupy a `maxRuns` slot, so later dispatches
  to that host stay `queued` until the run is cancelled (`tac cleanup` refuses non-terminal runs). In this e2e that
  happened to the check runs dispatched after PR #1 was merged, whose plan was already done.
- Agents push their run branch before opening the PR, also when the PR then cannot be opened: `run/ro1bqpflk-hello`
  and `run/rqzrccjx0-hello` stay on the remote after their runs were cleaned up.
- When idle, Claude Code shows a suggested next prompt in the input box (here "delete the remote branch", "merge the
  PR"). Pressing `enter` in an idle session from the UI key bar may submit it.
- `tac cleanup` leaves the local `run/<run>-hello` branch in the repo; delete it by hand if needed.

### Leftovers and stopping everything

PR #1 on `prettoandre/tac-e2e` (merged), PR #2 (open, from run `r63agm9er`, which only ticks the plan
checkboxes), the remote run branches listed above plus `run/r63agm9er-hello`, the repo itself, and the session of run
`r64tc7bsj` (worktree `~/worktrees/tac-e2e/r64tc7bsj` and herdr tab `r64tc7bsj`, both still present). To stop:

```bash
tac cleanup r64tc7bsj
kill <control pid>                                   # on the Mac
ssh devbox-homelab 'kill $(cat ~/.local/state/tac-e2e-logs/runner.pid)'
ssh devbox-homelab '~/.local/bin/herdr --session tac-e2e server stop && ~/.local/bin/herdr session delete tac-e2e'
```
