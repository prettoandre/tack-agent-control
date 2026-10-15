export type Command =
  | { cmd: "dispatch"; project: string; planPath: string; host?: string; agent?: "claude" | "codex" }
  | { cmd: "ls"; all: boolean }
  | { cmd: "show" | "cancel" | "retry" | "cleanup" | "open-pr" | "screen"; runId: string }
  | { cmd: "send"; runId: string; text: string }
  | { cmd: "help" };

const ONE_ID = ["show", "cancel", "retry", "cleanup", "open-pr", "screen"] as const;

export function parseArgs(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  if (cmd === "ls") return { cmd: "ls", all: rest.includes("--all") };
  if (cmd === "dispatch") {
    const pos: string[] = [];
    const opts: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("--")) { const v = rest[++i]; if (!v) return { cmd: "help" }; opts[a.slice(2)] = v; }
      else pos.push(a);
    }
    if (pos.length !== 2) return { cmd: "help" };
    if (opts.agent && opts.agent !== "claude" && opts.agent !== "codex") return { cmd: "help" };
    return { cmd: "dispatch", project: pos[0]!, planPath: pos[1]!,
      ...(opts.host ? { host: opts.host } : {}), ...(opts.agent ? { agent: opts.agent as "claude" | "codex" } : {}) };
  }
  if (cmd === "send" && rest.length >= 2) return { cmd: "send", runId: rest[0]!, text: rest.slice(1).join(" ") };
  if ((ONE_ID as readonly string[]).includes(cmd ?? "") && rest.length === 1)
    return { cmd: cmd as (typeof ONE_ID)[number], runId: rest[0]! };
  return { cmd: "help" };
}
