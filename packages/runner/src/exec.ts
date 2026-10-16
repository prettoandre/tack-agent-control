export type Exec = (
  cmd: string[],
  opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = async (cmd, opts) => {
  const p = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { code, stdout, stderr };
};
