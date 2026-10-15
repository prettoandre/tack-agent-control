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

Every new worktree shows it once. The run sits in `waiting_input`; answer it from the UI (`down`, `enter`: the
cursor starts on "No, exit"). The initial prompt is sent automatically once the agent becomes idle.

## 6. Cleanup

`tac cleanup <run>` after the PR is merged or closed. It removes the worktree and tab; the local `run/...` branch
is left in the repo.

## herdr and text that starts with `-` (verified on herdr 0.9.3)

`herdr pane send-text`, `agent prompt` and `agent send-keys` accept values that start with `-` as they are.
A `--` separator is not supported for them: `pane send-text <pane> -- "x"` types the literal `--` first, and
`agent prompt <name> -- -x` fails with `unknown option: -x`. The runner therefore passes user text without `--`.

## E2E setup used (2026-10-15)

`scripts/e2e-homelab.sh` (reads the token from `TAC_E2E_TOKEN_FILE`) reuses a control already listening on
`127.0.0.1:7780`, or starts one, waits for the host to be `ok`, dispatches the hello plan of the private repo
`tac-e2e` and polls `tac show` every 10 s for up to 15 minutes.

## E2E results (2026-10-15)

Setup: control on the Mac (`127.0.0.1:7780`, dev login), runner on devbox-homelab (`devbox-local` on the tailnet)
with a dedicated herdr session `tac-e2e`, private repo `prettoandre/tac-e2e` with the hello plan on `main`.

| Check | Result |
|---|---|
| Hello plan, project `tac-e2e` (haiku) | `queued -> preparing -> waiting_input` (trust dialog) as expected. After the dialog, see the prompt-delivery defect below. Final: `succeeded`, PR #1 `run/r64tc7bsj-hello`, one commit "feat: hello", file `hello.txt` containing `hello`. `run_events` lists every key and prompt input with login `dev`. |
| Empty `agentArgs` (R28), project `tac-e2e-noargs` | Agent started, reached `waiting_input`, no herdr argv error. Cancelled and cleaned up. |
| Tailscale Serve headers (R29) | See "Behind Tailscale Serve": `Host` and `X-Forwarded-Host` are the bare MagicDNS name, so `TAC_PUBLIC_HOSTS=<mac>.<tailnet>.ts.net`. |
| herdr `--` (R30) | Not supported and harmful; the runner passes text without it. See above. |
| Check 1: missing plan | `tac dispatch tac-e2e docs/superpowers/plans/missing.md` printed `error: plan_not_found: ... is not on origin/main; commit and push it first`; `tac ls --all` showed no new run. |
| Check 2: runner down about 60 s while two runs were active | Runner stopped at 20:09:07 and restarted at 20:10:16. The runs went `finishing -> unknown` (after the host was marked unreachable) and returned to `finishing` as soon as the runner was back. Never `failed`. A queued run stayed `queued` while the host was unreachable. The earlier redeploy (a few seconds of downtime) logged one `ECONNREFUSED` error event and no state change beyond the normal ones. |
| Check 3: two dispatches in a row | Two runs, two worktrees (`~/worktrees/tac-e2e/<run>`), two branches (`run/<run>-hello`). No trust dialog appeared because the folder was already trusted in the earlier session. |
| `scripts/e2e-homelab.sh` | Run with `TAC_E2E_TIMEOUT_S=45` against the already running control: reused control, host `ok`, dispatched, printed `queued -> preparing -> running`, then timed out as configured. The run was cancelled and cleaned up. |

### Prompt-delivery defect and fix (R33)

After the trust dialog was answered, the deferred plan prompt was typed into Claude's input box but never submitted
(the pane showed `❯ Execute the plan at ...` with no response, the run drifted `running -> finishing`). The runner now
tracks `promptAcked` and nudges with `enter` up to 3 times, at least 5 s apart (commit 9f0ff0e). After redeploying the
runner, the nudge submitted the stuck prompt, the agent started working and the run reached `succeeded`. The runner
restart itself did not fail the run.

### Findings

- Checkbox progress stayed `0/2` for the whole run: the agent never ticked the plan checkboxes. Do not use it as a
  completion signal until the Claude hooks source exists.
- Input after `succeeded` is accepted: control forwarded and recorded three prompts ("ok, siga", "faça a revisão
  final", "pode fazer o merge") sent into the still-alive session. That is consistent with the spec (the session lives
  until cleanup) and useful for follow-up, but nothing marks the run as active again, so the UI still shows
  `succeeded` while the agent works (here the agent merged PR #1). Recommendation: when input is accepted for a
  terminal run, show a warning in the UI, and/or move the run back to `running` so the loop tracks the agent again.
- Runs block on reading Claude Code plugin skill files outside the worktree (`~/.claude/plugins/...`), which shows a
  permission prompt and puts the run in `waiting_input`. Follow-up: write per-run Claude settings that allow those
  reads (`permissions.additionalDirectories` or a `Read(~/.claude/plugins/**)` allow rule).
- A text prompt sent while the agent is blocked returns `agent_blocked`. Use the key bar (`down`, `enter`, ...) in the
  UI to answer prompts.
- Runs that finish quickly can stay `finishing` and keep occupying a `maxRuns` slot, so later dispatches stay
  `queued` until they are cancelled or cleaned up.
- `tac cleanup` leaves the local `run/<run>-hello` branch in the repo; delete it by hand if needed.

### Leftovers and stopping everything

PR #1 on `prettoandre/tac-e2e` (merged), the repo itself, and the session of run `r64tc7bsj` (worktree
`~/worktrees/tac-e2e/r64tc7bsj`, herdr tab `r64tc7bsj`). To stop:

```bash
tac cleanup r64tc7bsj
kill <control pid>                                   # on the Mac
ssh devbox-homelab 'kill $(cat ~/.local/state/tac-e2e-logs/runner.pid)'
ssh devbox-homelab '~/.local/bin/herdr --session tac-e2e server stop && ~/.local/bin/herdr session delete tac-e2e'
```
