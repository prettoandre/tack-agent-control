import { expect, test } from "bun:test";
import { createRunnerApp } from "./server";
import { fakes, req } from "./runs.test";

const auth = { Authorization: "Bearer s3cret", "content-type": "application/json" };

test("health needs no token, everything else does", async () => {
  const app = createRunnerApp(fakes().mgr, "s3cret");
  expect((await app.request("/health")).status).toBe(200);
  expect((await app.request("/runs/raaaaaaaa/status")).status).toBe(401);
  expect((await app.request("/runs/raaaaaaaa/status", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
});

test("start then status", async () => {
  const app = createRunnerApp(fakes().mgr, "s3cret");
  const r = await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) });
  expect(r.status).toBe(201);
  const s = await (await app.request("/runs/raaaaaaaa/status", { headers: auth })).json();
  expect(s.known).toBe(true);
});

test("plan_not_found is 422, bad body is 400, unknown run is 404", async () => {
  const app = createRunnerApp(fakes({ planExists: false }).mgr, "s3cret");
  expect((await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) })).status).toBe(422);
  expect((await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify({ runId: "x" }) })).status).toBe(400);
  expect((await app.request("/runs/rzzzzzzzz/input", { method: "POST", headers: auth, body: JSON.stringify({ type: "keys", keys: ["enter"] }) })).status).toBe(404);
});

test("input with a blocked agent returns 409 with herdr code", async () => {
  const f = fakes();
  const app = createRunnerApp(f.mgr, "s3cret");
  await app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) });
  f.agents.get("raaaaaaaa")!.agentStatus = "blocked";
  const r = await app.request("/runs/raaaaaaaa/input", { method: "POST", headers: auth, body: JSON.stringify({ type: "prompt", text: "hi" }) });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("agent_blocked");
});

test("run ids that are not valid are rejected", async () => {
  const app = createRunnerApp(fakes().mgr, "s3cret");
  expect((await app.request("/runs/..%2Fx/status", { headers: auth })).status).toBe(400);
});

test("POST /runs answers 201 once the run is prepared, without waiting for the agent launch", async () => {
  let release!: () => void;
  const f = fakes({ startGate: new Promise<void>((r) => (release = r)) });
  const app = createRunnerApp(f.mgr, "s3cret");
  const r = await Promise.race([
    app.request("/runs", { method: "POST", headers: auth, body: JSON.stringify(req("raaaaaaaa")) }),
    Bun.sleep(1_000).then(() => null),
  ]);
  release();   // let a blocked synchronous start finish too, so nothing dangles after a failure
  expect(r?.status).toBe(201);
  expect(await r!.json()).toEqual({ runId: "raaaaaaaa", worktreePath: "/wt/proj/raaaaaaaa" });

  let s: any;
  for (let i = 0; i < 100; i++) {
    s = await (await app.request("/runs/raaaaaaaa/status", { headers: auth })).json();
    if (f.state.load("raaaaaaaa")?.promptSent) break;
    await Bun.sleep(5);
  }
  expect(f.state.load("raaaaaaaa")?.promptSent).toBe(true);
  expect(s.known).toBe(true);
});
