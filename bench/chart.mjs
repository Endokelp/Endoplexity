// The README's head-to-head figure, drawn from bench/results.json: Endoplexity's
// Claude row against Claude in Chrome, same CLI, same model. Small multiples,
// one panel per measure, so no two scales share an axis. Writes a light and a
// dark SVG; the README picks one with <picture> by the viewer's GitHub theme.
//
//   node bench/chart.mjs
import { readFileSync, writeFileSync } from "node:fs";

const { results, paired } = JSON.parse(readFileSync(new URL("results.json", import.meta.url), "utf8"));
// Row i of each panel: 0 is Endoplexity (claude-off), 1 is Claude in Chrome.
const rows = [["Endoplexity"], ["Claude in Chrome"]];
const m = paired.medians;
const n = paired.tasks;
const panels = [
  ["Tasks completed", "of 30 · higher wins", (i) => [results["claude-off"], results["cic-claude"]][i].success, (v) => `${v}`],
  ["Median time per task", `${n} both finished · lower wins`, (i) => m.wall_s[i], (v) => `${Math.round(v)} s`],
  ["Median tokens per task", `${n} both finished · lower wins`, (i) => m.tokens[i], (v) => `${Math.round(v / 1000)}k`],
  ["Median cost per task", `${n} both finished · API price`, (i) => m.cost_usd[i], (v) => `$${v.toFixed(2)}`],
];
// Validated with the dataviz skill's palette checker against GitHub's surfaces.
const themes = {
  light: { bg: "#ffffff", ink: "#1f2328", muted: "#59636e", rule: "#d1d9e0", series: ["#16804f", "#6250d6"] },
  dark: { bg: "#0d1117", ink: "#f0f6fc", muted: "#9198a1", rule: "#3d444d", series: ["#25a065", "#9085e9"] },
};

const W = 880, LABEL = 132, PW = (W - LABEL) / panels.length, BAR = 14, TOP = 58, ROW = 34;
const H = TOP + ROW * rows.length + 8;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function svg(t) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" role="img" aria-label="Endoplexity against Claude in Chrome on 30 Online-Mind2Web tasks, same CLI and model">`];
  // Bars grow from the baseline once, then the values fade in; still for reduced motion.
  out.push(`<style>.bar{transform-box:fill-box;transform-origin:0 50%;animation:grow .9s cubic-bezier(.2,.8,.2,1) both}.val{animation:fade .4s ease-out both}@keyframes grow{from{transform:scaleX(0)}}@keyframes fade{from{opacity:0}}@media (prefers-reduced-motion:reduce){.bar,.val{animation:none}}</style>`);
  out.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  rows.forEach(([name], i) => {
    const y = TOP + i * ROW + BAR / 2 + 4;
    out.push(`<rect x="0" y="${y - 9}" width="10" height="10" rx="2" fill="${t.series[i]}"/>`);
    out.push(`<text x="16" y="${y}" font-size="13" font-weight="600" fill="${t.ink}">${esc(name)}</text>`);
  });
  panels.forEach(([title, sub, get, fmt], p) => {
    const x0 = LABEL + p * PW + 8, span = PW - 64;
    const vals = rows.map((_, i) => get(i));
    const max = Math.max(...vals.filter(Number.isFinite), 1e-9);
    out.push(`<text x="${x0}" y="18" font-size="13" font-weight="600" fill="${t.ink}">${esc(title)}</text>`);
    out.push(`<text x="${x0}" y="35" font-size="11" fill="${t.muted}">${esc(sub)}</text>`);
    out.push(`<line x1="${x0}" y1="${TOP - 6}" x2="${x0}" y2="${TOP + ROW * rows.length - 14}" stroke="${t.rule}" stroke-width="1"/>`);
    vals.forEach((v, i) => {
      const y = TOP + i * ROW;
      if (!Number.isFinite(v)) {
        out.push(`<text x="${x0 + 4}" y="${y + 11}" font-size="12" fill="${t.muted}">n/a</text>`);
        return;
      }
      const w = Math.max(2, (v / max) * span);
      // Square at the baseline, 4 px round at the data end.
      const delay = (p * 0.15 + i * 0.08).toFixed(2);
      out.push(`<path class="bar" style="animation-delay:${delay}s" d="M${x0} ${y}h${w - 4}a4 4 0 0 1 4 4v${BAR - 8}a4 4 0 0 1 -4 4h${-(w - 4)}z" fill="${t.series[i]}"/>`);
      out.push(`<text class="val" style="animation-delay:${(+delay + 0.7).toFixed(2)}s" x="${x0 + w + 6}" y="${y + 11}" font-size="12" font-weight="600" fill="${t.ink}">${esc(fmt(v))}</text>`);
    });
  });
  out.push("</svg>");
  return out.join("\n") + "\n";
}

for (const [mode, t] of Object.entries(themes)) writeFileSync(new URL(`../docs/bench-${mode}.svg`, import.meta.url), svg(t));
console.log("docs/bench-light.svg, docs/bench-dark.svg");
