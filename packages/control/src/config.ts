import { parse } from "yaml";
import { z } from "zod";
import type { AgentKind } from "@tac/shared";

export class ConfigError extends Error {}
export interface ProjectConfig { name: string; host: string; repoPath: string; baseBranch: string; agent: AgentKind; agentArgs: string[] }
export interface HostConfig { name: string; url: string; token: string; maxRuns: number }

const Projects = z.object({ projects: z.record(z.object({
  host: z.string(), repoPath: z.string().startsWith("/"), baseBranch: z.string().default("main"),
  agent: z.enum(["claude", "codex"]).default("claude"), agentArgs: z.array(z.string()).default([]),
})) });
const Hosts = z.object({ hosts: z.record(z.object({ url: z.string().url(), maxRuns: z.number().int().min(1).default(2) })) });

// Runs never bypass permissions or sandboxing (spec global constraint).
const isForbiddenArg = (a: string) => a.startsWith("--dangerously-") || a === "--yolo" || a.includes("bypassPermissions");

export function loadConfig(projectsYaml: string, hostsYaml: string, env: Record<string, string | undefined>) {
  const p = Projects.safeParse(parse(projectsYaml));
  if (!p.success) throw new ConfigError(`projects.yaml: ${p.error.message}`);
  const h = Hosts.safeParse(parse(hostsYaml));
  if (!h.success) throw new ConfigError(`hosts.yaml: ${h.error.message}`);

  const hosts = new Map<string, HostConfig>();
  for (const [name, v] of Object.entries(h.data.hosts)) {
    const key = `TAC_TOKEN_${name.toUpperCase().replace(/-/g, "_")}`;
    const token = env[key];
    if (!token) throw new ConfigError(`missing ${key} for host ${name}`);
    hosts.set(name, { name, url: v.url, token, maxRuns: v.maxRuns });
  }
  const projects = new Map<string, ProjectConfig>();
  for (const [name, v] of Object.entries(p.data.projects)) {
    if (!hosts.has(v.host)) throw new ConfigError(`project ${name}: unknown host ${v.host}`);
    const bad = v.agentArgs.find(isForbiddenArg);
    if (bad) throw new ConfigError(`project ${name}: forbidden agent argument ${bad}`);
    projects.set(name, { name, ...v });
  }
  return { projects, hosts };
}
