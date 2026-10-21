# UI mockup: the tack-agent-control console

This is the approved visual design for sub-project 3 (web UI) of
`docs/superpowers/specs/2026-10-15-tack-agent-control-design.md`. The sub-project 3 spec and plan
build from it. The data in it is sample data, not measurements.

- Live canvas (private to the owner): https://claude.ai/artifact/Qk87EQ2AMTcAZDwcS3wou2
- Source of each screen: the `.dc.html` files here, a copy of the canvas on 2026-10-16. They render
  on the canvas (they need its `support.js` runtime); for implementation, read them as the reference
  for layout, copy and states, and rebuild them as React components.

## Screens

| File | Screen | What it shows |
|---|---|---|
| `Main.dc.html` | Fleet overview | Key figures (running, needs you, queued, PRs today, tokens); host cards with CPU, RAM, disk and agent slots; active runs table (progress, state, engines and models, host, tokens); "Needs you" queue with approve actions; next 6 hours; account quota windows |
| `Run.dc.html` | Run detail | Run header and actions; run figures; wave graph by DAG level; files-conflict notice; timeline of implement, review and fix per task; live terminal with message box and key bar; task detail with rounds; `events.jsonl` feed; tokens by model |
| `Dag.dc.html` | Wave task DAG | The wave's tasks as nodes with dependency edges from `depends:`, the previous wave (merged) and the next (queued), the critical path, and the files conflict that serializes two tasks |
| `Scheduler.dc.html` | Scheduler and queue | Day lanes per host with finished, running, scheduled, recurring and held blocks and a "now" line; the queue with the reason each item waits (quota window, previous wave's PR, project cap); recurring jobs; capacity rules |
| `Swarm.dc.html` | Swarm (interactive) | 150 simulated agents (30–300 via the canvas's Tweaks) as tiles per host, coloured by state, with counts, tasks completed, tokens per minute, output tokens per minute, agents by run and a live event feed |
| `Mobile.dc.html` | Phone | Answering an agent's permission prompt: the command, the live terminal, a large key bar and Approve or Deny |

`canvas.json` is the canvas index (frame sizes and order).

## Design tokens

Dark theme. One accent; state colours differ in lightness as well as hue.

| Token | Value | Use |
|---|---|---|
| ground | `#0A0B0D` | page background |
| sidebar / header | `#0D0E11` / `#0B0C0F` | chrome |
| surface | `#111317` | cards and panels |
| border | `#1F2329` (panels), `#2A2E36` (controls) | |
| text | `#E8EAED`; secondary `#C5C9D0`; muted `#9BA1AB`; faint `#8B919B` | faint is the lowest contrast allowed for text |
| accent | `#8B8CFF` | primary button, links `#A9AAFF` |
| running | `#5AA9FF` | |
| in review | `#B48CFF` | |
| needs you / waiting | `#F5A524` | |
| blocked / failed | `#FF6B6B` | |
| done / reviewed | `#3FCF8E` | |
| queued / pending | `#8B919B` | |
| engine chips | codex `#3FCF8E` on 10% tint; claude `#8B8CFF` on 12% tint | |
| type | Geist (UI), Geist Mono (ids, paths, commands, numbers in terminals) | Google Fonts |
| radius | 12px panels, 8px controls, 99px pills | |

## Data each screen needs

The screens assume these sources, all named in the specs:

- `tack wave status <spec> --wave N --json` (`tack.status/v1`): the DAG, levels, conflicts and per-task
  state, round, engine, model, commits, tokens and time (tack SDD contract v1, part 1a).
- `events.jsonl` beside each spec: the run's event feed and timeline.
- control's SQLite: runs, run events, hosts, queue and schedule.
- runner health checks: host CPU, RAM, disk and agent slots.
- OpenTelemetry from Claude Code and Codex, attributed per task through `OTEL_RESOURCE_ATTRIBUTES`
  (sub-project 4): tokens and time rates.
- account windows: Claude Max and Codex quota (sub-project 5).
