#!/usr/bin/env bun
// Extracts the <svg> from each docs/diagrams/*.html into a standalone .svg with its web fonts embedded,
// so GitHub can render it with <img>. The HTML files stay the source of truth; rerun after editing one.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "docs", "diagrams");
const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono:wght@400;600&family=Instrument+Serif:ital@0;1&display=block";
// Google serves woff2 only to a modern browser user agent.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function embeddedFontFaces(): Promise<string> {
  const css = await (await fetchOk(FONTS_CSS, { headers: { "user-agent": UA } })).text();
  // Each face comes as "/* subset */ @font-face {...}"; the diagrams only use Latin text.
  const blocks = [...css.matchAll(/\/\* ([\w-]+) \*\/\s*(@font-face \{[^}]+\})/g)].filter((m) => m[1] === "latin").map((m) => m[2]!);
  if (blocks.length === 0) throw new Error("no latin @font-face blocks in the Google Fonts CSS");
  const faces = await Promise.all(blocks.map(async (block) => {
    const url = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (!url) throw new Error(`no woff2 url in: ${block}`);
    const b64 = Buffer.from(await (await fetchOk(url)).arrayBuffer()).toString("base64");
    return block.replace(url, `data:font/woff2;base64,${b64}`).replace(/\s*unicode-range:[^;]+;/, "");
  }));
  return faces.join("\n");
}

const fontFaces = await embeddedFontFaces();
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(DIR, file), "utf8");
  const svg = html.match(/<svg[\s\S]*<\/svg>/)?.[0];
  if (!svg) throw new Error(`${file}: no <svg>`);
  const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/) ?? [];
  if (!w || !h) throw new Error(`${file}: no viewBox`);
  const out = svg
    .replace(/<svg /, `<svg width="${w}" height="${h}" `)
    .replace(/(<svg[^>]*>)/, `$1\n<style>\n${fontFaces}\n</style>`);
  const target = join(DIR, file.replace(/\.html$/, ".svg"));
  writeFileSync(target, out + "\n");
  console.log(`${target} (${Math.round(out.length / 1024)} KB)`);
}
