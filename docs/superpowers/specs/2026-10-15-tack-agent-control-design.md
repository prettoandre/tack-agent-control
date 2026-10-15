# tack-agent-control: dispatch and control of agent runs on the devboxes

Date: 2026-10-15
Status: design approved in conversation; block 1+2 detailed below, sub-projects 3-5 get their own specs
Repo: `tack-agent-control`, local at `~/workspace/tack-agent-control`

## Intent

Write specs and plans (with their task waves) on any machine, then run them on
the devbox that holds the project's data. The MacBook only defines work and
reviews results; it runs no agent load. One mobile-friendly web UI, reached
over the tailnet, shows everything that was dispatched or is running, gives
full interaction with a live agent session, shows history with cost, and
schedules runs.

## Decisions made by the user

- Approach A: a control plane of our own built on top of herdr. herdr runs the
  real interactive `claude` and `codex` sessions on each devbox; we build the
  control service, the per-devbox runner, the UI and the CLI.
- The UI serves both live operation and history with cost and metrics, and it
  must work from a phone over Tailscale (web UI, no native app).
- Full interaction: from the UI (phone included) the user can watch the live
  terminal, answer agent questions, approve permissions and send messages to a
  running session.
- The control service runs on a new dedicated VM on the homelab, provisioned
  by the `infra` repo (OpenTofu + Ansible).
- Scheduling covers delayed dispatch, recurring (cron) runs and a queue with
  capacity limits. Chained runs (B after A) are out of scope.
- Agent telemetry lives on the control VM (OpenTelemetry collector and
  storage there); it may be forwarded to `obs-htz` (infra sub-project 5) later.
- Code lives in its own repo, `tack-agent-control`. `infra` only provisions
  the VM and installs the services.
- Stack: TypeScript full-stack: Bun, Hono, React, xterm.js, SQLite.

## Assumptions

- Single user (the owner). No multi-tenant features.
- Access only over the tailnet, never the public internet.
- A run executes one superpowers plan, in a git worktree, on the devbox that
  holds the project's data and containers.
- Agents: Claude Code and Codex CLI, both already installed on the devboxes.

## Decomposition

| # | Sub-project | Scope |
|---|---|---|
| 1 | Base | `agent-control` VM via `infra`; herdr pinned and configured on the devboxes; runner installed as a user service |
| 2 | Dispatcher and runner | `control` API and data model, `runner` daemon, `tac` CLI, run lifecycle, minimal run list and attach view |
| 3 | Web UI | Full mobile-first UI: run list and detail, wave and task progress, live terminal with input, PR links, notifications |
| 4 | Telemetry | OTel collector on the control VM fed by Claude Code and Codex; cost, tokens, duration and failure-rate views |
| 5 | Scheduler and queue | Delayed dispatch, cron runs, capacity limits per host and per account |

This spec details sub-projects 1 and 2. Sub-projects 3-5 get their own spec,
plan and execution, and must follow the contracts below.

Dependencies outside this repo:

- `infra` sub-project 2b (role `devbox`): the Codex and Claude Code sandbox
  (bubblewrap, socat, AppArmor profile for `bwrap`) and the shared agent
  config. Runs do not require the sandbox (full interaction lets the user
  approve prompts), but without it every shell command asks for approval.

## Architecture

```
 Mac / phone (browser, tailnet)
          │ HTTPS + WebSocket (Tailscale Serve)
          ▼
 ┌──────────────── VM agent-control (homelab) ───────────────┐
 │ control: Hono API + React UI + SQLite                     │
 │   runs, events, projects.yaml, host registry              │
 │ tac CLI (on the Mac) is a thin client of this API         │
 └─────────────┬─────────────────────────────┬───────────────┘
               │ HTTP + WS (tailnet, token)  │
               ▼                             ▼
 ┌──── devbox-homelab ────┐      ┌──── devbox-htz ──────────┐
 │ runner (Bun, systemd   │      │ runner                   │
 │ --user, tailnet IP)    │      │                          │
 │   ↕ local socket / CLI │      │   ↕                      │
 │ herdr server (pinned)  │      │ herdr server (pinned)    │
 │   pane: claude / codex │      │   pane: claude / codex   │
 │   one worktree per run │      │                          │
 └────────────────────────┘      └──────────────────────────┘
```

### Components

**`control`** (on the `agent-control` VM)

- Owns all state and all decisions: which run goes where and when.
- Hono HTTP API plus WebSocket proxy to the runners; serves the React UI.
- SQLite database: `runs`, `run_events` (append-only), `hosts`.
- `projects.yaml`: maps each project to its repo URL, default host, base
  branch and default agent. Example: `leiloes_veiculos → devbox-homelab`,
  `sigamobilidade → devbox-htz`, `scaleisp → devbox-htz`.

**`runner`** (one per devbox, runs as `apretto` under `systemd --user`)

- No business rules. A closed set of operations:
  - prepare a run: `git fetch`, `git worktree add`, open a herdr tab, start
    the agent with the initial prompt;
  - stream the live terminal: bridge `herdr agent attach` through a pty to a
    WebSocket;
  - send input: text and keys through `herdr agent prompt` / `send-keys`;
  - report state: agent state from herdr, plan checkbox progress, hook events,
    PR lookup;
  - cancel and clean up: stop the agent, close the tab, remove the worktree.
- Never runs arbitrary commands sent by `control`.
- Keeps only transient state. After a restart it rebuilds run state from
  `herdr api snapshot` and the worktrees on disk.

**`tac`** (CLI on the Mac)

- Thin client of the `control` API: `tac dispatch`, `tac ls`, `tac show`,
  `tac attach`, `tac send`, `tac cancel`, `tac retry`, `tac open-pr`.
- The Mac runs no agents.

## Run lifecycle

### Dispatch

```
tac dispatch <project> <plan-path> [--host auto|<host>] [--agent claude|codex]
```

1. `control` checks that the plan is committed and pushed: it reads the plan
   file from the base branch on `origin`. A plan that exists only locally is
   rejected with a clear error. The devbox runs exactly what was pushed.
2. Host selection: `--host auto` (the default) uses `projects.yaml`.
3. The run is created as `queued`. In this block the queue is a simple limit
   of N concurrent runs per host (default 2, set per host in the registry);
   sub-project 5 replaces it with the full scheduler.
4. When capacity allows, `control` sends the run to the host's runner.

### States

```
queued → preparing → running ⇄ waiting_input → finishing → succeeded
                        │                                 ↘ needs_attention
                        └→ cancelled / failed
unknown: the host is unreachable; resolved by reconciliation
```

- `preparing`: the runner fetches, creates the worktree
  `~/worktrees/<repo>/<run-id>` on branch `run/<run-id>-<plan-slug>`, opens a
  tab in the repo's herdr workspace and starts the agent **interactively**
  with the prompt: execute plan `<plan-path>` with
  `superpowers:subagent-driven-development`.
- `running` / `waiting_input`: mapped from herdr's agent state. When the agent
  asks a question or a permission, the run moves to `waiting_input` and the
  UI shows the terminal so the user can answer. Runs never use
  `bypassPermissions`.
- Progress per wave and task comes from two sources:
  - the `- [ ]` / `- [x]` checkboxes of the plan file inside the worktree;
  - Claude Code hooks (`SubagentStart`, `SubagentStop`) that the runner
    installs for the run and that post events to the runner. Codex runs use
    checkboxes only.
- `finishing` → result:
  - the agent is idle and `gh pr list --head run/<run-id>-...` finds a PR:
    `succeeded`, PR link stored;
  - the agent is idle with no PR for longer than the idle timeout (default
    15 minutes): `needs_attention`, the user is notified;
  - the agent process died: `failed`.
- Cleanup: the worktree and the herdr tab stay until the PR is merged or
  closed. A UI button or a cleanup job then removes both.

### Actions

`attach` (live terminal), `send` (message to the session), `cancel`, `retry`
(dispatch again on the same branch, so committed work is kept), `open-pr`.

## Error handling

- Runner or devbox down: `control` health-checks each runner every 15 s.
  After 3 consecutive failures the host is `unreachable` and its active runs
  become `unknown`, not `failed`. When the runner returns, it rebuilds state
  from herdr and `control` reconciles each run.
- `control` restarted: state is in SQLite; runs keep going on the devboxes and
  are reconciled on start.
- herdr restarted: the pane is gone, the run becomes `failed`. Commits already
  on the branch are kept; `retry` continues from them.
- Rule learned from the 2026-10-15 Codex POC: the system never trusts an
  agent's own report. State and results come only from verifiable artifacts:
  herdr process state, commits, plan checkboxes and an existing PR.

## Security

- UI and API are reachable only over the tailnet, published with Tailscale
  Serve. The user identity comes from Tailscale Serve's identity headers; only
  the owner is allowed.
- Each runner listens only on its tailnet IP, accepts only `control` (per-host
  token from 1Password plus a Tailscale ACL rule that lets only
  `tag:agent-control` reach the runner port), and exposes only the closed
  operations above.
- Full interaction gives a shell on the devbox through the agent. Every input
  sent through `control` is recorded in `run_events` with time and source.
- No project secret passes through `control`. `.env` files and credentials
  stay on the devbox.

## Infra (sub-project 1)

Done in the `infra` repo, following its contracts (catalog, `vm` module, tag
standard, Ansible roles):

- VM `agent-control` on the homelab: Ubuntu 24.04 with the homelab VM
  defaults (single disk, qemu-guest-agent, Tailscale, English locale,
  `America/Sao_Paulo`, zram), sized 2 vCPU / 4 GB.
- Tailscale: tag `tag:agent-control` for the VM; ACL rule from that tag to the
  runner port on the devboxes; Tailscale Serve for the UI.
- Ansible: install `control` on the VM and `runner` on both devboxes as
  services; pin and configure herdr on the devboxes; put the runner tokens in
  place from 1Password.

## Testing

- Unit: the state machine, `projects.yaml` parsing and validation, the plan
  checkbox parser, reconciliation.
- Runner integration: against a real herdr with a fake agent (a script that
  goes through working, waiting for input and done), so no tokens are spent.
- End to end on one devbox: a tiny sample plan in a test repo, run with
  haiku, from `tac dispatch` to an open PR.
- herdr is pinned; the runner integration suite runs before any herdr update.

## Out of scope for block 1+2

- The full UI (sub-project 3). Block 1+2 ships only a run list and the attach
  view.
- OTel telemetry (sub-project 4).
- Scheduling and the full queue (sub-project 5).
- The agent sandbox (`infra` sub-project 2b).
- Chained runs and multi-user access.
