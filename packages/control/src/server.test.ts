import { expect, test } from "bun:test";
import { RunnerCallError } from "./runner-client";
import { allowedHostsFor, createControlApp, hostGuard, isLoopbackHost } from "./server";
import { Store } from "./store";
import { run } from "./store.test";

function setup(inputImpl?: () => Promise<void>) {
  const store = new Store(":memory:");
  const calls: string[] = [];
  const client = () => ({
    input: inputImpl ?? (async () => {}),
    cancel: async (id: string) => { calls.push(`cancel ${id}`); }, cleanup: async () => {}, screen: async () => "SCREEN",
    checkPlan: async () => true,
  }) as any;
  const projects = new Map([["p", { name: "p", host: "h1", repoPath: "/r", baseBranch: "main", agent: "claude" as const, agentArgs: [] }]]);
  const hosts = new Map([["h1", { name: "h1", url: "http://x", token: "t", maxRuns: 2 }]]);
  const loop = { hostState: () => "ok" } as any;
  const app = createControlApp({
    store, loop, client, allowedLogins: ["me@x"], allowedHosts: ["localhost", "c.ts.net"],
    dispatchDeps: { store, projects, hosts, client, now: () => 1 },
  });
  return { app, store, calls };
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

test("hostGuard accepts allowed hosts and same-allowlist origins only", () => {
  const allowed = ["127.0.0.1:7780", "c.ts.net"];
  expect(hostGuard(allowed, { host: "127.0.0.1:7780" })).toBeNull();
  expect(hostGuard(allowed, { host: "c.ts.net", origin: "" })).toBeNull();
  expect(hostGuard(allowed, { host: "c.ts.net", origin: "https://c.ts.net" })).toBeNull();
  expect(hostGuard(allowed, { host: "127.0.0.1:7780", forwardedHost: "c.ts.net", origin: "https://c.ts.net" })).toBeNull();
  expect(hostGuard(allowed, { host: "C.TS.NET" })).toBeNull();
  expect(hostGuard(allowed, { host: "c.ts.net", origin: "https://evil.example" })).toBe("forbidden_origin");
  expect(hostGuard(allowed, { host: "c.ts.net", origin: "not a url" })).toBe("forbidden_origin");
  // DNS rebinding: the browser sends the attacker's name in both Host and Origin
  expect(hostGuard(allowed, { host: "evil.example:7780", origin: "http://evil.example:7780" })).toBe("forbidden_host");
  // X-Forwarded-Host can be set by page scripts, so it never replaces the Host check
  expect(hostGuard(allowed, { host: "evil.example:7780", forwardedHost: "c.ts.net" })).toBe("forbidden_host");
  expect(hostGuard(allowed, { host: "c.ts.net", forwardedHost: "evil.example" })).toBe("forbidden_host");
  expect(hostGuard(allowed, {})).toBe("forbidden_host");
});

test("allowedHostsFor lists the loopback names for the port plus the public hosts", () => {
  expect(allowedHostsFor("7780")).toEqual(["127.0.0.1:7780", "localhost:7780", "[::1]:7780"]);
  expect(allowedHostsFor(7780, " Agent-Control.tail39ebd.ts.net, ,b.ts.net ")).toEqual([
    "127.0.0.1:7780", "localhost:7780", "[::1]:7780", "agent-control.tail39ebd.ts.net", "b.ts.net",
  ]);
});

test("isLoopbackHost accepts loopback listen names only", () => {
  for (const h of ["127.0.0.1", "localhost", "::1"]) expect(isLoopbackHost(h)).toBe(true);
  for (const h of ["0.0.0.0", "100.64.0.1", "192.168.1.10", "", "::", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
});

test("reads from a foreign Host are rejected (DNS rebinding)", async () => {
  const { app } = setup();
  const r = await app.request("/api/runs", { headers: { ...H, Host: "evil.example:7780" } });
  expect(r.status).toBe(403);
  expect((await r.json()).error.code).toBe("forbidden_host");
  const f = await app.request("/api/runs", { headers: { ...H, Host: "c.ts.net", "X-Forwarded-Host": "evil.example" } });
  expect(f.status).toBe(403);
});

test("cancel of a terminal run is 409 and never reaches the runner", async () => {
  const { app, store, calls } = setup();
  for (const [id, state] of [["raaaaaaaa", "succeeded"], ["rbbbbbbbb", "failed"], ["rcccccccc", "cancelled"]] as const) {
    store.insertRun(run(id, { state }));
    const r = await app.request(`/api/runs/${id}/cancel`, { method: "POST", headers: H });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("not_cancellable");
    expect(store.getRun(id)?.state).toBe(state);
  }
  expect(calls).toEqual([]);
  store.insertRun(run("rdddddddd", { state: "running" }));
  expect((await app.request("/api/runs/rdddddddd/cancel", { method: "POST", headers: H })).status).toBe(204);
  expect(calls).toEqual(["cancel rdddddddd"]);
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
