/**
 * Chart renderer — SVG PURO, zero dipendenze native (no canvas/sharp/chartjs).
 *
 * Perché SVG puro è SUPERIORE per questo caso:
 *   - bundle-safe (niente .node binari) + sandbox-safe (no fs/native);
 *   - output testuale → embeddabile inline nell'HTML email come data-URI;
 *   - deterministico → testabile riga per riga (no rasterizzazione).
 *
 * SICUREZZA (bug-bounty): l'SVG finisce dentro un'email HTML. Ogni testo da DATO
 * UTENTE (label, titolo, valori) DEVE essere XSS-escaped: una label
 * `</text><script>…` altrimenti inietterebbe script nel client di posta.
 * → `escapeXml` applicato a OGNI stringa interpolata nell'SVG.
 *
 * Robustezza: dati vuoti → placeholder "nessun dato" (mai crash); valori non
 * numerici/NaN → 0; singolo punto → render; valori negativi → scala con zero-baseline.
 */

export type ChartType = 'line' | 'bar' | 'pie' | 'area';

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartRenderOptions {
  type: ChartType;
  title?: string | undefined;
  width: number;
  height: number;
  palette: readonly string[];
}

export const PALETTES: Record<string, readonly string[]> = {
  default: ['#0ea5e9', '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'],
  blues: ['#0c4a6e', '#0369a1', '#0284c7', '#0ea5e9', '#38bdf8', '#7dd3fc'],
  greens: ['#064e3b', '#047857', '#059669', '#10b981', '#34d399', '#6ee7b7'],
  warm: ['#7c2d12', '#c2410c', '#ea580c', '#f97316', '#fb923c', '#fdba74'],
};

/** XSS-safe: escape dei 5 caratteri pericolosi in XML/SVG/HTML. */
export function escapeXml(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Coord/numero → stringa per i template SVG (numeri non ammessi in template
 *  dalla config lint; conversione esplicita output-preserving). */
const sx = (v: number): string => String(v);

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Label arbitraria → stringa sicura (oggetto → JSON, non "[object Object]"). */
function toLabel(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** Scala "nice": ritorna [min, max] arrotondati che includono 0 quando sensato. */
function niceBounds(values: readonly number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 1 };
  // reduce, NON Math.min/max(...values): un chart su dataset grande → spread RangeError.
  let min = values.reduce((m, v) => (v < m ? v : m), Infinity);
  let max = values.reduce((m, v) => (v > m ? v : m), -Infinity);
  if (min > 0) min = 0; // baseline a 0 per le barre positive
  if (max < 0) max = 0;
  if (min === max) {
    max = min + 1;
  } // evita divisione per 0
  return { min, max };
}

function svgHeader(width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sx(width)}" height="${sx(height)}" viewBox="0 0 ${sx(width)} ${sx(height)}" font-family="system-ui,Arial,sans-serif">` +
    `<rect width="${sx(width)}" height="${sx(height)}" fill="#ffffff"/>`
  );
}

function titleEl(title: string | undefined, width: number): string {
  if (!title) return '';
  return `<text x="${sx(width / 2)}" y="26" text-anchor="middle" font-size="18" font-weight="700" fill="#0b0b0d">${escapeXml(title)}</text>`;
}

function placeholder(opts: ChartRenderOptions): string {
  return (
    svgHeader(opts.width, opts.height) +
    titleEl(opts.title, opts.width) +
    `<text x="${sx(opts.width / 2)}" y="${sx(opts.height / 2)}" text-anchor="middle" font-size="16" fill="#71717a">Nessun dato da visualizzare</text></svg>`
  );
}

// ─── renderers ───────────────────────────────────────────────────────────────

const PAD = { top: 44, right: 24, bottom: 56, left: 56 };

function plotArea(opts: ChartRenderOptions): { x: number; y: number; w: number; h: number } {
  return {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, opts.width - PAD.left - PAD.right),
    h: Math.max(1, opts.height - PAD.top - PAD.bottom),
  };
}

function axes(a: { x: number; y: number; w: number; h: number }, min: number, max: number): string {
  const zeroY = a.y + a.h - ((0 - min) / (max - min)) * a.h;
  return (
    `<line x1="${sx(a.x)}" y1="${sx(a.y)}" x2="${sx(a.x)}" y2="${sx(a.y + a.h)}" stroke="#d4d4d8"/>` +
    `<line x1="${sx(a.x)}" y1="${sx(zeroY)}" x2="${sx(a.x + a.w)}" y2="${sx(zeroY)}" stroke="#d4d4d8"/>` +
    `<text x="${sx(a.x - 8)}" y="${sx(a.y + 4)}" text-anchor="end" font-size="11" fill="#71717a">${escapeXml(max)}</text>` +
    `<text x="${sx(a.x - 8)}" y="${sx(a.y + a.h)}" text-anchor="end" font-size="11" fill="#71717a">${escapeXml(min)}</text>`
  );
}

function xLabels(
  points: readonly ChartPoint[],
  a: { x: number; y: number; w: number; h: number },
): string {
  const n = points.length;
  const step = a.w / n;
  // diluisce le label se troppe (max ~12 visibili) per non sovrapporle
  const every = Math.max(1, Math.ceil(n / 12));
  return points
    .map((p, i) =>
      i % every !== 0
        ? ''
        : `<text x="${sx(a.x + step * (i + 0.5))}" y="${sx(a.y + a.h + 18)}" text-anchor="middle" font-size="11" fill="#52525b">${escapeXml(p.label)}</text>`,
    )
    .join('');
}

function renderBars(points: readonly ChartPoint[], opts: ChartRenderOptions): string {
  const a = plotArea(opts);
  const { min, max } = niceBounds(points.map((p) => p.value));
  const step = a.w / points.length;
  const bw = step * 0.7;
  const zeroY = a.y + a.h - ((0 - min) / (max - min)) * a.h;
  const bars = points
    .map((p, i) => {
      const vy = a.y + a.h - ((p.value - min) / (max - min)) * a.h;
      const top = Math.min(vy, zeroY);
      const h = Math.abs(vy - zeroY);
      const x = a.x + step * i + (step - bw) / 2;
      const color = opts.palette[i % opts.palette.length] ?? '#0ea5e9';
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="3"><title>${escapeXml(p.label)}: ${escapeXml(p.value)}</title></rect>`;
    })
    .join('');
  return (
    svgHeader(opts.width, opts.height) +
    titleEl(opts.title, opts.width) +
    axes(a, min, max) +
    bars +
    xLabels(points, a) +
    '</svg>'
  );
}

function renderLine(
  points: readonly ChartPoint[],
  opts: ChartRenderOptions,
  fill: boolean,
): string {
  const a = plotArea(opts);
  const { min, max } = niceBounds(points.map((p) => p.value));
  const step = points.length > 1 ? a.w / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = points.length > 1 ? a.x + step * i : a.x + a.w / 2;
    const y = a.y + a.h - ((p.value - min) / (max - min)) * a.h;
    return { x, y };
  });
  const color = opts.palette[0] ?? '#0ea5e9';
  const path = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');
  const firstC = coords[0];
  const lastC = coords[coords.length - 1];
  const area =
    fill && firstC && lastC
      ? `<path d="${path} L${lastC.x.toFixed(1)},${(a.y + a.h).toFixed(1)} L${firstC.x.toFixed(1)},${(a.y + a.h).toFixed(1)} Z" fill="${color}" fill-opacity="0.15"/>`
      : '';
  const dots = coords
    .map((c, i) => {
      const p = points[i];
      return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="${color}"><title>${escapeXml(p?.label)}: ${escapeXml(p?.value)}</title></circle>`;
    })
    .join('');
  const line = `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
  return (
    svgHeader(opts.width, opts.height) +
    titleEl(opts.title, opts.width) +
    axes(a, min, max) +
    area +
    line +
    dots +
    xLabels(points, a) +
    '</svg>'
  );
}

function renderPie(points: readonly ChartPoint[], opts: ChartRenderOptions): string {
  const total = points.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return placeholder(opts); // tutte le fette ≤ 0 → niente da disegnare
  const cx = opts.width / 2;
  const cy = (opts.height + PAD.top) / 2;
  const r = Math.max(10, Math.min(opts.width, opts.height - PAD.top) / 2 - 40);
  let angle = -Math.PI / 2; // parte da ore 12
  const slices = points
    .map((p, i) => {
      const frac = Math.max(0, p.value) / total;
      const a0 = angle;
      const a1 = angle + frac * 2 * Math.PI;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0),
        y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1),
        y1 = cy + r * Math.sin(a1);
      const color = opts.palette[i % opts.palette.length] ?? '#0ea5e9';
      // full-circle (1 sola fetta = 100%): un arco non chiude, usa due semicerchi
      if (frac >= 0.9999) {
        return `<circle cx="${sx(cx)}" cy="${sx(cy)}" r="${sx(r)}" fill="${color}"><title>${escapeXml(p.label)}: 100%</title></circle>`;
      }
      return `<path d="M${sx(cx)},${sx(cy)} L${x0.toFixed(1)},${y0.toFixed(1)} A${sx(r)},${sx(r)} 0 ${sx(large)} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${color}"><title>${escapeXml(p.label)}: ${(frac * 100).toFixed(1)}%</title></path>`;
    })
    .join('');
  const legend = points
    .map(
      (p, i) =>
        `<rect x="${sx(opts.width - 150)}" y="${sx(PAD.top + i * 20)}" width="12" height="12" fill="${opts.palette[i % opts.palette.length] ?? '#0ea5e9'}"/>` +
        `<text x="${sx(opts.width - 132)}" y="${sx(PAD.top + i * 20 + 11)}" font-size="11" fill="#52525b">${escapeXml(p.label)}</text>`,
    )
    .join('');
  return (
    svgHeader(opts.width, opts.height) +
    titleEl(opts.title, opts.width) +
    slices +
    legend +
    '</svg>'
  );
}

/**
 * Render principale. `rawPoints` può avere value non numerici (coerciti a 0).
 * Ritorna sempre un SVG valido (placeholder se vuoto).
 */
export function renderChartSvg(
  rawPoints: readonly { label: unknown; value: unknown }[],
  opts: ChartRenderOptions,
): string {
  const points: ChartPoint[] = rawPoints.map((p) => ({
    label: toLabel(p.label),
    value: num(p.value),
  }));
  if (points.length === 0) return placeholder(opts);
  switch (opts.type) {
    case 'pie':
      return renderPie(points, opts);
    case 'line':
      return renderLine(points, opts, false);
    case 'area':
      return renderLine(points, opts, true);
    case 'bar':
    default:
      return renderBars(points, opts);
  }
}

/** SVG → data-URI base64 (embeddabile in `<img src>` dell'email HTML). */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
