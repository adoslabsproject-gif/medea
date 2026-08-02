/**
 * action_generate_chart — executor.
 *
 * Genera un grafico SVG (line/bar/pie/area) da un array di dati, embeddabile
 * nell'HTML di un'email (data-URI) o usabile come SVG raw. Zero dipendenze native
 * (vedi chart-render.ts). Tutti i campi sono configurabili da UI con default
 * sensati → a prova di idiota.
 *
 * NOMI CAMPI: matchano ESATTAMENTE `config.X` del NodeDef `chartGenerateNode`
 * in packages/engine/nodes/stdlib/src/actions/chart.ts.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import {
  renderChartSvg,
  svgToDataUri,
  escapeXml,
  PALETTES,
  type ChartType,
} from './chart-render.js';

const CHART_TYPES: ReadonlySet<string> = new Set(['line', 'bar', 'pie', 'area']);
const MAX_POINTS = 500;
const clampDim = (v: unknown, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(4000, Math.max(100, Math.round(n))) : def;
};

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : coerceString(v);
}

/** Normalizza l'input (array di oggetti / numeri / coppie / JSON-string) in {label,value}[]. */
export function coerceChartData(
  raw: unknown,
  labelField: string,
  valueField: string,
): { label: unknown; value: unknown }[] {
  let data = raw;
  if (typeof data === 'string') {
    const t = data.trim();
    if (t === '') return [];
    try {
      data = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(data)) return [];
  return (data as unknown[]).slice(0, MAX_POINTS).map((row, i) => {
    if (Array.isArray(row)) {
      const arr = row as unknown[];
      return { label: arr[0] ?? i, value: arr[1] };
    } // [label, value]
    if (row !== null && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      return { label: o[labelField] ?? i, value: o[valueField] }; // {label, value}
    }
    return { label: i, value: row }; // numero grezzo
  });
}

export const chartGenerateExecutor: NodeExecutor = (config, input, _context) => {
  const start = Date.now();
  const type = (
    CHART_TYPES.has(asString(config.chartType)) ? asString(config.chartType) : 'bar'
  ) as ChartType;
  const labelField = asString(config.labelField) || 'label';
  const valueField = asString(config.valueField) || 'value';
  // Dati: dal field dataJson (espressione interpolata) o, se assente, dall'input del nodo.
  const rawData = config.dataJson !== undefined && config.dataJson !== '' ? config.dataJson : input;
  const points = coerceChartData(rawData, labelField, valueField);

  const width = clampDim(config.width, 800);
  const height = clampDim(config.height, 400);
  const palette = PALETTES[asString(config.palette)] ?? PALETTES.default!;
  const title = asString(config.title);

  const svg = renderChartSvg(points, { type, title: title || undefined, width, height, palette });
  const outputFormat = asString(config.outputFormat) || 'dataUri';
  const dataUri = svgToDataUri(svg);

  const warnings: string[] = [];
  if (points.length === 0)
    warnings.push(
      'Nessun dato valido: generato un grafico placeholder. Controlla dataJson / labelField / valueField.',
    );

  return Promise.resolve({
    output: {
      svg,
      dataUri,
      width,
      height,
      pointCount: points.length,
      // pronto-all'uso: tag <img> già formato per l'email HTML. `title` è input utente →
      // alt XSS-escaped (escapeXml escapa anche `"`): senza, un title con `"><script>`
      // romperebbe l'attributo e inietterebbe HTML nell'email destinataria.
      imgTag: `<img src="${dataUri}" width="${width}" height="${height}" alt="${escapeXml(title || 'chart')}" style="max-width:100%;height:auto" />`,
      ...(outputFormat === 'svg' ? { primary: svg } : { primary: dataUri }),
    },
    durationMs: Date.now() - start,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
};
