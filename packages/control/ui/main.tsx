import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import type { Run, RunEvent, RunnerInput, RunState } from "@tac/shared";
import { getJson, keyFor, post, progressLabel, stateColor } from "./api";

function Badge({ state }: { state: RunState }) {
  return <span className="badge"><span className="dot" style={{ background: stateColor(state) }} />{state}</span>;
}

function age(ms: number) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function RunList({ onOpen }: { onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    const load = () => getJson<Run[]>("/api/runs").then(setRuns).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  const sorted = [...runs].sort((a, b) => Number(b.state === "waiting_input") - Number(a.state === "waiting_input"));
  return (
    <div>
      <h2>Runs</h2>
      {sorted.map((r) => (
        <div key={r.id} className="row" onClick={() => onOpen(r.id)}>
          <Badge state={r.state} />
          <strong>{r.project}</strong>
          <span className="muted mono">{r.id}</span>
          <span className="muted">{r.planPath.split("/").pop()}</span>
          <span className="muted">{progressLabel(r.progress)}</span>
          <span className="muted">{r.host} · {age(r.createdAt)}</span>
          {r.prUrl && <a href={r.prUrl} target="_blank" onClick={(e) => e.stopPropagation()}>PR</a>}
        </div>
      ))}
    </div>
  );
}

function RunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const termEl = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const [data, setData] = useState<{ run: Run; events: RunEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const send = (input: RunnerInput) => ws.current?.send(JSON.stringify(input));

  useEffect(() => {
    const load = () => getJson<{ run: Run; events: RunEvent[] }>(`/api/runs/${id}`).then(setData).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 3000);
    const term = new Terminal({ convertEol: true, fontSize: 13, fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace', theme: { background: "#0f1011", foreground: "#f7f8f8" }, scrollback: 2000 });
    term.open(termEl.current!);
    term.onKey(({ domEvent }) => {
      const k = keyFor(domEvent);
      if (k) send({ type: "keys", keys: [k] });
      else if (domEvent.key.length === 1) send({ type: "text", text: domEvent.key });
    });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws.current = new WebSocket(`${proto}://${location.host}/api/runs/${id}/terminal`);
    ws.current.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "screen") { term.reset(); term.write(msg.data); setError(null); }
      if (msg.type === "error") setError(msg.code);
    };
    return () => { clearInterval(t); ws.current?.close(); term.dispose(); };
  }, [id]);

  const act = (path: string) => post(`/api/runs/${id}/${path}`).catch((e) => setError(e.message));

  return (
    <div>
      <div className="bar"><button onClick={onBack}>← Runs</button>
        {data && <Badge state={data.run.state} />}
        {data && <strong>{data.run.project}</strong>}
        {data && <span className="muted mono">{data.run.id}</span>}
        {data && <span className="muted">{progressLabel(data.run.progress)}</span>}
        {data?.run.prUrl && <a href={data.run.prUrl} target="_blank">PR</a>}
      </div>
      {error && <div className="err">{error}</div>}
      <div id="term" className="card" ref={termEl} />
      <div className="bar">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message to the agent" />
        <button className="primary" onClick={() => { if (text) { send({ type: "prompt", text }); setText(""); } }}>Send</button>
      </div>
      <div className="bar">
        {["up", "down", "enter", "esc", "ctrl+c"].map((k) => <button key={k} onClick={() => send({ type: "keys", keys: [k] })}>{k}</button>)}
        {["y", "n"].map((k) => <button key={k} onClick={() => send({ type: "text", text: k })}>{k}</button>)}
        <button onClick={() => act("cancel")}>Cancel</button>
        <button onClick={() => act("retry")}>Retry</button>
      </div>
      <h3>Events</h3>
      {data?.events.slice().reverse().map((e, i) => (
        <div key={i} className="muted">{new Date(e.at).toLocaleTimeString()} {e.kind} {e.source} {JSON.stringify(e.data)}</div>
      ))}
    </div>
  );
}

function App() {
  const [open, setOpen] = useState<string | null>(null);
  return open ? <RunDetail id={open} onBack={() => setOpen(null)} /> : <RunList onOpen={setOpen} />;
}

createRoot(document.getElementById("root")!).render(<App />);
