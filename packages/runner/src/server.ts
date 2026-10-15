import { Hono } from "hono";
import { z } from "zod";
import { GitError } from "./git";
import { HerdrError } from "./herdr";
import { RunNotFound, type RunManager } from "./runs";

const RunId = z.string().regex(/^r[a-z0-9]{8}$/);
const StartReq = z.object({
  runId: RunId, project: z.string().regex(/^[a-zA-Z0-9_.-]+$/), repoPath: z.string().min(1),
  baseBranch: z.string().min(1), planPath: z.string().min(1), branch: z.string().startsWith("run/"),
  agent: z.enum(["claude", "codex"]), agentArgs: z.array(z.string()), prompt: z.string().min(1),
});
const Input = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ type: z.literal("keys"), keys: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
]);
const CheckPlan = z.object({ repoPath: z.string(), baseBranch: z.string(), planPath: z.string() });

const err = (code: string, message = code) => ({ error: { code, message } });

export function createRunnerApp(mgr: RunManager, token: string) {
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof z.ZodError) return c.json(err("bad_request", e.message), 400);
    if (e instanceof RunNotFound) return c.json(err("run_not_found", e.message), 404);
    if (e instanceof HerdrError) return c.json(err(e.code, e.message), e.code === "plan_not_found" ? 422 : 409);
    if (e instanceof GitError) return c.json(err("git_error", e.stderr), 500);
    return c.json(err("internal", String(e)), 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${token}`) return c.json(err("unauthorized"), 401);
    await next();
  });

  const id = (raw: string) => RunId.parse(raw);

  app.post("/check-plan", async (c) => {
    const b = CheckPlan.parse(await c.req.json());
    return c.json({ exists: await mgr.checkPlan(b.repoPath, b.baseBranch, b.planPath) });
  });
  app.post("/runs", async (c) => {
    const rec = await mgr.start(StartReq.parse(await c.req.json()));
    return c.json({ runId: rec.runId, worktreePath: rec.worktreePath }, 201);
  });
  app.get("/runs/:id/status", async (c) => c.json(await mgr.status(id(c.req.param("id")))));
  app.post("/runs/:id/input", async (c) => {
    await mgr.input(id(c.req.param("id")), Input.parse(await c.req.json()));
    return c.body(null, 204);
  });
  app.get("/runs/:id/screen", async (c) => {
    const lines = Math.min(Math.max(Number(c.req.query("lines") ?? 200) || 200, 1), 2000);
    return c.text(await mgr.screen(id(c.req.param("id")), lines));
  });
  app.post("/runs/:id/cancel", async (c) => { await mgr.cancel(id(c.req.param("id"))); return c.body(null, 204); });
  app.post("/runs/:id/cleanup", async (c) => { await mgr.cleanup(id(c.req.param("id"))); return c.body(null, 204); });

  return app;
}
