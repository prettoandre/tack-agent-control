import type { AgentKind, HerdrAgentStatus } from "@tac/shared";
import type { Exec } from "./exec";

export class HerdrError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface HerdrAgent {
  name: string; agentStatus: HerdrAgentStatus; paneId: string; tabId: string;
  workspaceId: string; cwd: string; launchPending: boolean;
}

const STATUSES: readonly HerdrAgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function toAgent(a: any): HerdrAgent {
  const s = STATUSES.includes(a.agent_status) ? a.agent_status : "unknown";
  return {
    name: a.name, agentStatus: s, paneId: a.pane_id, tabId: a.tab_id,
    workspaceId: a.workspace_id, cwd: a.cwd, launchPending: Boolean(a.launch_pending),
  };
}

function parseError(text: string): { code: string; message: string } | null {
  try {
    const j = JSON.parse(text);
    if (j?.error?.code) return { code: j.error.code, message: j.error.message ?? "" };
  } catch {}
  return null;
}

export class Herdr {
  constructor(private exec: Exec, private bin = "herdr", private session?: string) {}

  private async raw(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const prefix = this.session ? [this.bin, "--session", this.session] : [this.bin];
    return this.exec([...prefix, ...args]);
  }

  private async json(args: string[]): Promise<any> {
    const r = await this.raw(args);
    if (r.code !== 0) {
      const e = parseError(r.stderr) ?? parseError(r.stdout);
      throw new HerdrError(e?.code ?? `exit_${r.code}`, e?.message ?? r.stderr.trim());
    }
    const j = JSON.parse(r.stdout);
    if (j.error) throw new HerdrError(j.error.code, j.error.message ?? "");
    return j.result;
  }

  private async text(args: string[]): Promise<string> {
    const r = await this.raw(args);
    if (r.code !== 0) {
      const e = parseError(r.stderr) ?? parseError(r.stdout);
      throw new HerdrError(e?.code ?? `exit_${r.code}`, e?.message ?? r.stderr.trim());
    }
    return r.stdout;
  }

  async listWorkspaces() {
    const r = await this.json(["workspace", "list"]);
    return (r.workspaces as any[]).map((w) => ({ workspaceId: w.workspace_id as string, label: w.label as string }));
  }

  async createWorkspace(cwd: string, label: string) {
    const r = await this.json(["workspace", "create", "--cwd", cwd, "--label", label]);
    return { workspaceId: r.workspace.workspace_id as string, paneId: r.root_pane.pane_id as string };
  }

  async createTab(workspaceId: string, cwd: string, label: string) {
    const r = await this.json(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label]);
    return { tabId: r.tab.tab_id as string, paneId: r.root_pane.pane_id as string };
  }

  async closeTab(tabId: string) {
    await this.json(["tab", "close", tabId]);
  }

  async startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<"ready" | "blocked"> {
    try {
      await this.json(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "60000", "--", ...args]);
      return "ready";
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_not_ready") return "blocked";
      throw e;
    }
  }

  async getAgent(name: string): Promise<HerdrAgent | null> {
    try {
      return toAgent((await this.json(["agent", "get", name])).agent);
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_not_found") return null;
      throw e;
    }
  }

  async listAgents(): Promise<HerdrAgent[]> {
    return ((await this.json(["agent", "list"])).agents as any[]).map(toAgent);
  }

  async prompt(name: string, text: string) {
    await this.json(["agent", "prompt", name, text]);
  }

  async sendKeys(name: string, keys: string[]) {
    await this.json(["agent", "send-keys", name, ...keys]);
  }

  async sendText(paneId: string, text: string) {
    await this.json(["pane", "send-text", paneId, text]);
  }

  async readPane(paneId: string, lines: number, format: "text" | "ansi") {
    return this.text(["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", format]);
  }
}
