const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "r";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function planSlug(planPath: string): string {
  const base = planPath.split("/").pop() ?? planPath;
  return base
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function branchName(runId: string, planPath: string): string {
  return `run/${runId}-${planSlug(planPath)}`.slice(0, 64).replace(/-+$/, "");
}
