import type { RunnerInput, RunnerRunStatus, RunnerStartRequest } from "@tac/shared";
import type { HostConfig } from "./config";

export class RunnerCallError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface RunnerClient {
  health(): Promise<boolean>;
  checkPlan(b: { repoPath: string; baseBranch: string; planPath: string }): Promise<boolean>;
  start(r: RunnerStartRequest): Promise<void>;
  status(id: string): Promise<RunnerRunStatus>;
  input(id: string, i: RunnerInput): Promise<void>;
  screen(id: string, lines: number): Promise<string>;
  cancel(id: string): Promise<void>;
  cleanup(id: string): Promise<void>;
}

export class HttpRunnerClient implements RunnerClient {
  constructor(private host: HostConfig, private fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetchImpl(`${this.host.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.host.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      throw new RunnerCallError(res.status, j?.error?.code ?? `http_${res.status}`, j?.error?.message ?? res.statusText);
    }
    return res;
  }

  async health() {
    try { return (await this.fetchImpl(`${this.host.url}/health`, { signal: AbortSignal.timeout(5_000) })).ok; }
    catch { return false; }
  }
  async checkPlan(b: { repoPath: string; baseBranch: string; planPath: string }) {
    return ((await (await this.call("POST", "/check-plan", b)).json()) as { exists: boolean }).exists;
  }
  async start(r: RunnerStartRequest) { await this.call("POST", "/runs", r); }
  async status(id: string) { return (await (await this.call("GET", `/runs/${id}/status`)).json()) as RunnerRunStatus; }
  async input(id: string, i: RunnerInput) { await this.call("POST", `/runs/${id}/input`, i); }
  async screen(id: string, lines: number) { return (await this.call("GET", `/runs/${id}/screen?lines=${lines}`)).text(); }
  async cancel(id: string) { await this.call("POST", `/runs/${id}/cancel`); }
  async cleanup(id: string) { await this.call("POST", `/runs/${id}/cleanup`); }
}
