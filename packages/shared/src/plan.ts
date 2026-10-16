import type { PlanProgress, TaskProgress, WaveProgress } from "./types";

const BOX = /^\s*- \[( |x|X)\] /;

export function parsePlanProgress(markdown: string): PlanProgress {
  const waves: WaveProgress[] = [];
  let wave: WaveProgress | null = null;
  let task: TaskProgress | null = null;
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.startsWith("## ")) {
      wave = { title: line.slice(3).trim(), tasks: [] };
      waves.push(wave);
      task = null;
      continue;
    }
    if (line.startsWith("### ")) {
      if (!wave) { wave = { title: "", tasks: [] }; waves.push(wave); }
      task = { title: line.slice(4).trim(), done: 0, total: 0 };
      wave.tasks.push(task);
      continue;
    }
    const m = BOX.exec(line);
    if (m && task) {
      task.total += 1;
      if (m[1] !== " ") task.done += 1;
    }
  }

  const kept = waves.filter((w) => w.tasks.length > 0);
  let done = 0, total = 0;
  for (const w of kept) for (const t of w.tasks) { done += t.done; total += t.total; }
  return { waves: kept, done, total };
}
