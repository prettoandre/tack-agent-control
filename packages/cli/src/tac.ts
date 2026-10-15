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
