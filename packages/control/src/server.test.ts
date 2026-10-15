import { expect, test } from "bun:test";
import { RunnerCallError } from "./runner-client";
import { createControlApp, originAllowed } from "./server";
import { Store } from "./store";
import { run } from "./store.test";

function setup(inputImpl?: () => Promise<void>) {
  const store = new Store(":memory:");
  const client = () => ({
    input: inputImpl ?? (async () => {}),
    cancel: async () => {}, cleanup: async () => {}, screen: async () => "SCREEN",
    checkPlan: async () => true,
  }) as any;
  const projects = new Map([["p", { name: "p", host: "h1", repoPath: "/r", baseBranch: "main", agent: "claude" as const, agentArgs: [] }]]);
  const hosts = new Map([["h1", { name: "h1", url: "http://x", token: "t", maxRuns: 2 }]]);
  const loop = { hostState: () => "ok" } as any;
  const app = createControlApp({
    store, loop, client, allowedLogins: ["me@x"],
    dispatchDeps: { store, projects, hosts, client, now: () => 1 },
  });
  return { app, store };
}
const H = { "Tailscale-User-Login": "me@x", "content-type": "application/json" };

test("only allowed tailscale logins pass", async () => {
  const { app } = setup();
  expect((await app.request("/api/runs")).status).toBe(401);
  expect((await app.request("/api/runs", { headers: { "Tailscale-User-Login": "other@x" } })).status).toBe(401);
  expect((await app.request("/api/runs", { headers: H })).status).toBe(200);
});

test("dispatch via API", async () => {
  const { app } = setup();
  const r = await app.request("/api/runs", { method: "POST", headers: H, body: JSON.stringify({ project: "p", planPath: "docs/x.md" }) });
  expect(r.status).toBe(201);
  expect((await r.json()).state).toBe("queued");
});

test("input is audited before forwarding, and a rejected input is audited too", async () => {
  const { app, store } = setup(async () => { throw new RunnerCallError(409, "agent_blocked", "blocked"); });
  store.insertRun(run("raaaaaaaa", { state: "running" }));
  const r = await app.request("/api/runs/raaaaaaaa/input", { method: "POST", headers: H, body: JSON.stringify({ type: "prompt", text: "hi" }) });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("agent_blocked");
  const kinds = store.events("raaaaaaaa").map((e) => [e.kind, e.source]);
  expect(kinds).toEqual([["input", "user"], ["error", "control"]]);
  expect(store.events("raaaaaaaa")[0]!.data).toEqual({ input: { type: "prompt", text: "hi" }, login: "me@x" });
});

test("retry reuses the branch; cleanup needs a terminal run", async () => {
  const { app, store } = setup();
  store.insertRun(run("raaaaaaaa", { state: "failed", branch: "run/raaaaaaaa-x" }));
  const r = await (await app.request("/api/runs/raaaaaaaa/retry", { method: "POST", headers: H })).json();
  expect(r.branch).toBe("run/raaaaaaaa-x");
  expect(r.state).toBe("queued");
  store.insertRun(run("rbbbbbbbb", { state: "running" }));
  expect((await app.request("/api/runs/rbbbbbbbb/cleanup", { method: "POST", headers: H })).status).toBe(409);
});

test("originAllowed accepts absent or same-host origins only", () => {
  expect(originAllowed({})).toBe(true);
  expect(originAllowed({ origin: "", host: "c.ts.net" })).toBe(true);
  expect(originAllowed({ origin: "https://c.ts.net", host: "c.ts.net" })).toBe(true);
  expect(originAllowed({ origin: "https://c.ts.net", host: "127.0.0.1:7780", forwardedHost: "c.ts.net" })).toBe(true);
  expect(originAllowed({ origin: "https://evil.example", host: "c.ts.net" })).toBe(false);
  expect(originAllowed({ origin: "not a url", host: "c.ts.net" })).toBe(false);
});

test("cross-origin posts are rejected without side effects", async () => {
  const { app, store } = setup();
  const r = await app.request("/api/runs", { method: "POST", headers: { ...H, Origin: "https://evil.example", Host: "c.ts.net" }, body: JSON.stringify({ project: "p", planPath: "docs/x.md" }) });
  expect(r.status).toBe(403);
  expect((await r.json()).error.code).toBe("forbidden_origin");
  expect(store.listRuns({})).toEqual([]);
});

test("non-JSON posts are rejected with 415", async () => {
  const { app } = setup();
  const r = await app.request("/api/runs", { method: "POST", headers: { ...H, "content-type": "text/plain" }, body: JSON.stringify({ project: "p", planPath: "docs/x.md" }) });
  expect(r.status).toBe(415);
  expect((await r.json()).error.code).toBe("unsupported_media_type");
});
