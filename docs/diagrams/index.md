# tack-agent-control diagrams

Made with the diagram-design skill, console dark skin (paper #0A0B0D, accent #8B8CFF, state colours from the UI mockup). Each file is a self-contained HTML page.

| File | Type | What it shows |
|---|---|---|
| `tac-deployment.html` | Deployment (doc-wide 1280×720) | What runs on which machine (owner devices, homelab Proxmox, Hetzner, GitHub), ports and tokens, with running-today vs planned marked; the Tailscale ACL plan is in a callout. |
| `tac-architecture.html` | Architecture (doc-wide 1280×720) | control, runner, tac, herdr panes (claude/codex today, `tack wave run` planned) and GitHub; the runner's closed set of five operations with their endpoints; the live-terminal path highlighted. |
| `tac-dispatch-sequence.html` | Sequence (fit 1280×900) | One run from `tac dispatch` to a PR in 12 numbered messages, with a `loop` for the 5 s status poll, an `opt` for the trust/permission answer from the phone, and the run state on control's lifeline. |
| `tac-run-state.html` | State machine, Lifecycle phase map pattern (doc-wide 1280×720) | The run states and the guards `decide()` applies (idle + PR, 15 min without PR, process died, cancel), with `unknown` as an overlay for an unreachable host. |
| `tack-and-control.html` | Layer stack (doc-wide 1280×720) | Projects adopt tack, tack publishes a versioned contract, tack-agent-control reads it and dispatches to the devboxes and agents; the contract layer is focal. |
