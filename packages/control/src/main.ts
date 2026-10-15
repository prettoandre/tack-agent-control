import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerInput } from "@tac/shared";
import { loadConfig } from "./config";
import { ControlLoop } from "./loop";
import { HttpRunnerClient, type RunnerClient } from "./runner-client";
import { allowedHostsFor, createControlApp, hostGuard, InputSchema, isLoopbackHost, loginOf, sendInput } from "./server";
import { Store } from "./store";

const env = process.env;
const [hostname, port] = (env.TAC_CONTROL_LISTEN ?? "127.0.0.1:7780").split(":");
if (!isLoopbackHost(hostname!)) {
  console.error(`TAC_CONTROL_LISTEN must be a loopback address (127.0.0.1, localhost or ::1), got "${hostname}": `
    + "control trusts the Tailscale-User-Login header, so it must be reachable only through Tailscale Serve");
  process.exit(1);
}
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
  allowedHosts: allowedHostsFor(port!, env.TAC_PUBLIC_HOSTS),
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
      const guard = hostGuard(deps.allowedHosts, {
        host: req.headers.get("Host") ?? new URL(req.url).host,
        forwardedHost: req.headers.get("X-Forwarded-Host"), origin: req.headers.get("Origin"),
      });
      if (guard) return new Response(guard, { status: 403 });
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
