/** Minimal dependency-free SVG bar chart with error bars. Light/dark safe (uses currentColor-free fixed palette). */

export interface Bar { label: string; value: number; n?: number; err?: number; group?: string }

const PALETTE = ["#4C6EF5", "#F76707", "#12B886", "#AE3EC9", "#F59F00", "#868E96"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function barChart(opts: { title: string; subtitle?: string; bars: Bar[]; yLabel: string; yMin?: number; yMax?: number; width?: number; height?: number; format?: (v: number) => string }): string {
  const W = opts.width ?? 720, H = opts.height ?? 400;
  const padL = 64, padR = 24, padT = 64, padB = 96;
  const bars = opts.bars;
  const fmt = opts.format ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2)));
  const vals = bars.flatMap((b) => [b.value + (b.err ?? 0), b.value - (b.err ?? 0)]).filter(Number.isFinite);
  let yMin = opts.yMin ?? Math.min(0, ...vals), yMax = opts.yMax ?? Math.max(0, ...vals);
  if (yMin === yMax) { yMax = yMin + 1; }
  const span = yMax - yMin;
  yMin -= span * 0.05; yMax += span * 0.1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const y = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const groups = [...new Set(bars.map((b) => b.group ?? ""))];
  const slot = plotW / Math.max(1, bars.length);
  const bw = Math.min(64, slot * 0.7);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="12">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="${padL}" y="26" font-size="16" font-weight="600" fill="#212529">${esc(opts.title)}</text>`);
  if (opts.subtitle) parts.push(`<text x="${padL}" y="46" fill="#495057">${esc(opts.subtitle)}</text>`);
  // gridlines
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + ((yMax - yMin) * i) / ticks;
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e9ecef"/>`);
    parts.push(`<text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" fill="#868E96">${esc(fmt(v))}</text>`);
  }
  if (yMin < 0 && yMax > 0) parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#adb5bd" stroke-width="1.2"/>`);
  parts.push(`<text transform="translate(16 ${padT + plotH / 2}) rotate(-90)" text-anchor="middle" fill="#495057">${esc(opts.yLabel)}</text>`);
  bars.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2;
    const color = PALETTE[groups.indexOf(b.group ?? "") % PALETTE.length];
    const v = Number.isFinite(b.value) ? b.value : 0;
    const top = Math.min(y(v), y(0)), h = Math.abs(y(v) - y(0));
    if (Number.isFinite(b.value)) {
      parts.push(`<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" fill="${color}" rx="3"/>`);
      if (b.err !== undefined && Number.isFinite(b.err)) {
        parts.push(`<line x1="${cx}" x2="${cx}" y1="${y(v + b.err).toFixed(1)}" y2="${y(v - b.err).toFixed(1)}" stroke="#343a40" stroke-width="1.5"/>`);
        parts.push(`<line x1="${cx - 6}" x2="${cx + 6}" y1="${y(v + b.err).toFixed(1)}" y2="${y(v + b.err).toFixed(1)}" stroke="#343a40" stroke-width="1.5"/>`);
        parts.push(`<line x1="${cx - 6}" x2="${cx + 6}" y1="${y(v - b.err).toFixed(1)}" y2="${y(v - b.err).toFixed(1)}" stroke="#343a40" stroke-width="1.5"/>`);
      }
      parts.push(`<text x="${cx}" y="${(top - 6).toFixed(1)}" text-anchor="middle" fill="#212529" font-weight="600">${esc(fmt(b.value))}</text>`);
    } else {
      parts.push(`<text x="${cx}" y="${(y(0) - 6).toFixed(1)}" text-anchor="middle" fill="#868E96">n/a</text>`);
    }
    const label = b.label.length > 18 ? b.label.slice(0, 17) + "…" : b.label;
    parts.push(`<text x="${cx}" y="${padT + plotH + 18}" text-anchor="middle" fill="#212529">${esc(label)}</text>`);
    if (b.n !== undefined) parts.push(`<text x="${cx}" y="${padT + plotH + 34}" text-anchor="middle" fill="#868E96">n=${b.n}</text>`);
  });
  if (groups.length > 1 && groups.some((g) => g)) {
    let lx = padL;
    for (const g of groups) {
      const color = PALETTE[groups.indexOf(g) % PALETTE.length];
      parts.push(`<rect x="${lx}" y="${H - 22}" width="12" height="12" fill="${color}" rx="2"/>`);
      parts.push(`<text x="${lx + 16}" y="${H - 12}" fill="#495057">${esc(g || "default")}</text>`);
      lx += 16 + g.length * 7 + 24;
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}
