import type { PlanProgress, RunState } from "@tac/shared";

const COLORS: Record<RunState, string> = {
  queued: "#6b7280", preparing: "#2563eb", running: "#2563eb", waiting_input: "#d97706", finishing: "#7c3aed",
  succeeded: "#16a34a", needs_attention: "#d97706", failed: "#dc2626", cancelled: "#6b7280", unknown: "#9ca3af",
};
export const stateColor = (s: RunState) => COLORS[s];
export const progressLabel = (p: PlanProgress | null) => (p && p.total ? `${p.done}/${p.total}` : "-");

const KEYS: Record<string, string> = {
  Enter: "enter", Escape: "esc", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Tab: "tab", Backspace: "backspace",
};
export function keyFor(e: { key: string; ctrlKey: boolean }): string | null {
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return `ctrl+${e.key.toLowerCase()}`;
  return KEYS[e.key] ?? null;
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.code ?? `http_${r.status}`);
  return r.json() as Promise<T>;
}
export async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.code ?? `http_${r.status}`);
}
