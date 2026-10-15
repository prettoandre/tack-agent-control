import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { newRunId, TERMINAL_STATES, type RunnerInput } from "@tac/shared";
import { dispatch, DispatchError, type DispatchDeps } from "./dispatch";
import type { ControlLoop } from "./loop";
import { RunnerCallError, type RunnerClient } from "./runner-client";
import type { Store } from "./store";

export interface ControlDeps {
  store: Store; loop: Pick<ControlLoop, "hostState">; dispatchDeps: DispatchDeps;
  client: (host: string) => RunnerClient; allowedLogins: string[]; devLogin?: string; uiDir?: string;
}

export const InputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ type: z.literal("keys"), keys: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
]);
const Input = InputSchema;
const DispatchBody = z.object({
  project: z.string(), planPath: z.string().min(1), host: z.string().optional(), agent: z.enum(["claude", "codex"]).optional(),
});
const err = (code: string, message = code) => ({ error: { code, message } });

export function loginOf(d: Pick<ControlDeps, "allowedLogins" | "devLogin">, header: string | undefined): string | null {
  const login = d.devLogin ?? header ?? null;
  return login && d.allowedLogins.includes(login) ? login : null;
}

/** CSRF guard: a browser Origin must match the Host (or X-Forwarded-Host) the request came in on. */
export function originAllowed(h: { origin?: string | null; host?: string | null; forwardedHost?: string | null }): boolean {
  if (!h.origin) return true;
  let originHost: string;
  try { originHost = new URL(h.origin).host; } catch { return false; }
  return originHost === h.host || originHost === h.forwardedHost;
}

/** Audit, then forward. Returns null on success or { status, code, message } on failure. */
export async function sendInput(d: ControlDeps, runId: string, input: RunnerInput, login: string) {
  const run = d.store.getRun(runId);
  if (!run) return { status: 404, code: "run_not_found", message: runId };
  d.store.addEvent({ runId, at: Date.now(), kind: "input", source: "user", data: { input, login } });
  try {
    await d.client(run.host).input(runId, input);
    return null;
  } catch (e) {
    const code = e instanceof RunnerCallError ? e.code : "runner_error";
    const status = e instanceof RunnerCallError ? e.status : 502;
    d.store.addEvent({ runId, at: Date.now(), kind: "error", source: "control", data: { code, message: String((e as Error).message) } });
    return { status, code, message: String((e as Error).message) };
  }
}

export function createControlApp(d: ControlDeps) {
  const app = new Hono<{ Variables: { login: string } }>();

  app.onError((e, c) => {
    if (e instanceof z.ZodError) return c.json(err("bad_request", e.message), 400);
    if (e instanceof DispatchError) return c.json(err(e.code, e.message), e.code === "plan_not_found" ? 422 : 400);
    if (e instanceof RunnerCallError) return c.json(err(e.code, e.message), e.status as any);
    return c.json(err("internal", String(e)), 500);
  });

  app.use("/api/*", async (c, next) => {
    const login = loginOf(d, c.req.header("Tailscale-User-Login"));
    if (!login) return c.json(err("unauthorized"), 401);
    c.set("login", login);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD") return next();
    const origin = c.req.header("Origin");
    if (!originAllowed({ origin, host: c.req.header("Host"), forwardedHost: c.req.header("X-Forwarded-Host") })) {
      return c.json(err("forbidden_origin"), 403);
    }
    if (m === "POST" && !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json(err("unsupported_media_type"), 415);
    }
    await next();
  });

  const mustRun = (id: string) => {
    const r = d.store.getRun(id);
    if (!r) throw new RunnerCallError(404, "run_not_found", id);
    return r;
  };

  app.get("/api/runs", (c) => {
    const states = c.req.query("state")?.split(",").filter(Boolean) as any;
    return c.json(d.store.listRuns({ states }));
  });
  app.get("/api/runs/:id", (c) => {
    const run = mustRun(c.req.param("id"));
    return c.json({ run, events: d.store.events(run.id) });
  });
  app.get("/api/hosts", (c) => c.json([...d.dispatchDeps.hosts.values()].map((h) => ({
    name: h.name, state: d.loop.hostState(h.name), active: d.store.countActive(h.name), maxRuns: h.maxRuns,
  }))));

  app.post("/api/runs", async (c) => c.json(await dispatch(d.dispatchDeps, DispatchBody.parse(await c.req.json())), 201));

  app.post("/api/runs/:id/input", async (c) => {
    const res = await sendInput(d, c.req.param("id"), Input.parse(await c.req.json()), c.get("login"));
    return res ? c.json(err(res.code, res.message), res.status as any) : c.body(null, 204);
  });

  app.get("/api/runs/:id/screen", async (c) => {
    const run = mustRun(c.req.param("id"));
    return c.text(await d.client(run.host).screen(run.id, Number(c.req.query("lines") ?? 200)));
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const run = mustRun(c.req.param("id"));
    if (run.state !== "queued") await d.client(run.host).cancel(run.id);
    d.store.updateRun(run.id, { state: "cancelled", finishedAt: Date.now() });
    d.store.addEvent({ runId: run.id, at: Date.now(), kind: "state", source: "user", data: { from: run.state, to: "cancelled", login: c.get("login") } });
    return c.body(null, 204);
  });

  app.post("/api/runs/:id/retry", async (c) => {
    const old = mustRun(c.req.param("id"));
    if (!TERMINAL_STATES.includes(old.state) && old.state !== "needs_attention") return c.json(err("not_retryable"), 409);
    // git refuses one branch in two worktrees: free the old worktree first (keeps the branch and its commits)
    try { await d.client(old.host).cleanup(old.id); }
    catch (e) { if (!(e instanceof RunnerCallError && e.code === "run_not_found")) throw e; }
    if (old.state === "needs_attention") d.store.updateRun(old.id, { state: "cancelled", finishedAt: Date.now() });
    const now = Date.now();
    const run = { ...old, id: newRunId(), state: "queued" as const, prUrl: null, progress: null, idleSince: null,
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
    d.store.insertRun(run);
    d.store.addEvent({ runId: run.id, at: now, kind: "dispatch", source: "user", data: { retryOf: old.id, login: c.get("login") } });
    return c.json(run, 201);
  });

  app.post("/api/runs/:id/cleanup", async (c) => {
    const run = mustRun(c.req.param("id"));
    if (!TERMINAL_STATES.includes(run.state)) return c.json(err("not_terminal"), 409);
    await d.client(run.host).cleanup(run.id);
    return c.body(null, 204);
  });

  if (d.uiDir) app.use("/*", serveStatic({ root: d.uiDir }));
  return app;
}
