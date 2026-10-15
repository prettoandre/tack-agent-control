import { expect, test } from "bun:test";
import { parseArgs } from "./args";

test("dispatch with options", () => {
  expect(parseArgs(["dispatch", "leiloes_veiculos", "docs/p.md", "--host", "devbox-htz", "--agent", "codex"]))
    .toEqual({ cmd: "dispatch", project: "leiloes_veiculos", planPath: "docs/p.md", host: "devbox-htz", agent: "codex" });
});

test("simple commands", () => {
  expect(parseArgs(["ls"])).toEqual({ cmd: "ls", all: false });
  expect(parseArgs(["ls", "--all"])).toEqual({ cmd: "ls", all: true });
  expect(parseArgs(["cancel", "raaaaaaaa"])).toEqual({ cmd: "cancel", runId: "raaaaaaaa" });
  expect(parseArgs(["send", "raaaaaaaa", "continue", "please"])).toEqual({ cmd: "send", runId: "raaaaaaaa", text: "continue please" });
});

test("bad input gives help", () => {
  expect(parseArgs([])).toEqual({ cmd: "help" });
  expect(parseArgs(["dispatch", "x"])).toEqual({ cmd: "help" });
  expect(parseArgs(["cancel"])).toEqual({ cmd: "help" });
  expect(parseArgs(["dispatch", "p", "x.md", "--agent", "gpt"])).toEqual({ cmd: "help" });
});
