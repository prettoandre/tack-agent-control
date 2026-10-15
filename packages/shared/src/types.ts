export const RUN_STATES = [
  "queued", "preparing", "running", "waiting_input", "finishing",
  "succeeded", "needs_attention", "failed", "cancelled", "unknown",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];
export const ACTIVE_STATES: readonly RunState[] = [
  "preparing", "running", "waiting_input", "finishing", "needs_attention", "unknown",
];

export type AgentKind = "claude" | "codex";
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface TaskProgress { title: string; done: number; total: number }
export interface WaveProgress { title: string; tasks: TaskProgress[] }
export interface PlanProgress { waves: WaveProgress[]; done: number; total: number }

export interface Run {
  id: string;
  project: string;
  host: string;
  agent: AgentKind;
  planPath: string;
  baseBranch: string;
  branch: string;
  state: RunState;
  prUrl: string | null;
  progress: PlanProgress | null;
  idleSince: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type RunEventKind = "state" | "input" | "progress" | "error" | "dispatch";
export type RunEventSource = "control" | "runner" | "user";
export interface RunEvent {
  runId: string;
  at: number;
  kind: RunEventKind;
  source: RunEventSource;
  data: Record<string, unknown>;
}

/** What a runner reports about one run. Facts only, no decisions. */
export interface RunnerRunStatus {
  runId: string;
  known: boolean;          // runner has a state file for this run
  agentPresent: boolean;   // herdr still sees the named agent
  agentStatus: HerdrAgentStatus | null;
  promptSent: boolean;     // the initial prompt was submitted
  progress: PlanProgress | null;
  prUrl: string | null;
  headSha: string | null;
}

/** Body of POST /runs on the runner. */
export interface RunnerStartRequest {
  runId: string;
  project: string;
  repoPath: string;      // existing clone on the devbox
  baseBranch: string;
  planPath: string;
  branch: string;
  agent: AgentKind;
  agentArgs: string[];
  prompt: string;
}

export type RunnerInput =
  | { type: "prompt"; text: string }
  | { type: "keys"; keys: string[] }
  | { type: "text"; text: string };

export interface ApiError { error: { code: string; message: string } }
