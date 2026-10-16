import { expect, test } from "bun:test";
import { ConfigError, loadConfig } from "./config";

const P = `projects:\n  leiloes_veiculos:\n    host: devbox-homelab\n    repoPath: /home/a/workspace/leiloes_veiculos\n    baseBranch: main\n    agent: claude\n    agentArgs: ["--model", "haiku"]\n`;
const H = `hosts:\n  devbox-homelab:\n    url: http://devbox-homelab:7781\n    maxRuns: 2\n`;

test("loads projects and hosts with tokens from env", () => {
  const c = loadConfig(P, H, { TAC_TOKEN_DEVBOX_HOMELAB: "t1" });
  expect(c.projects.get("leiloes_veiculos")?.agentArgs).toEqual(["--model", "haiku"]);
  expect(c.hosts.get("devbox-homelab")).toEqual({ name: "devbox-homelab", url: "http://devbox-homelab:7781", token: "t1", maxRuns: 2 });
});

test("missing token, unknown host and bad agent fail with a clear message", () => {
  expect(() => loadConfig(P, H, {})).toThrow("TAC_TOKEN_DEVBOX_HOMELAB");
  expect(() => loadConfig(P.replace("devbox-homelab", "nope"), H, { TAC_TOKEN_DEVBOX_HOMELAB: "t" })).toThrow(ConfigError);
  expect(() => loadConfig(P.replace("agent: claude", "agent: gpt"), H, { TAC_TOKEN_DEVBOX_HOMELAB: "t" })).toThrow(ConfigError);
});

test("agentArgs that bypass permissions are rejected naming project and argument", () => {
  const env = { TAC_TOKEN_DEVBOX_HOMELAB: "t" };
  const withArgs = (args: string[]) => P.replace('["--model", "haiku"]', JSON.stringify(args));
  expect(() => loadConfig(withArgs(["--dangerously-skip-permissions"]), H, env)).toThrow(/leiloes_veiculos.*--dangerously-skip-permissions/);
  expect(() => loadConfig(withArgs(["--permission-mode", "bypassPermissions"]), H, env)).toThrow(/leiloes_veiculos.*bypassPermissions/);
  expect(() => loadConfig(withArgs(["--yolo"]), H, env)).toThrow(ConfigError);
  expect(() => loadConfig(withArgs(["--permission-mode=bypassPermissions"]), H, env)).toThrow(ConfigError);
});
