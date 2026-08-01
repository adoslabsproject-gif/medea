import { describe, it, expect } from 'vitest';
import { renderChartSvg, escapeXml, svgToDataUri, PALETTES, type ChartType } from './chart-render.js';

const opts = (type: ChartType) => ({ type, width: 400, height: 300, palette: PALETTES.default! });
const ALL_TYPES: ChartType[] = ['bar', 'line', 'area', 'pie'];

describe('escapeXml — XSS surface', () => {
  it('escapa i 5 caratteri pericolosi', () => {
    expect(escapeXml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&apos;');
    expect(escapeXml(null)).toBe('');
    expect(escapeXml(42)).toBe('42');
  });
});

describe('🔒 [BUG-BOUNTY] XSS: label malevola NON inietta markup nell’SVG (va in email HTML)', () => {
  it.each(ALL_TYPES)('%s: </text><script> nella label → escaped, niente <script> nell’output', (type) => {
    const svg = renderChartSvg([
      { label: '</text><script>alert(document.cookie)</script>', value: 10 },
      { label: 'x"onload="alert(1)', value: 20 },
    ], opts(type));
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('</text><script');
    expect(svg).not.toMatch(/onload="alert/);
    expect(svg).toContain('&lt;script&gt;'); // la label è presente ma escaped
  });

  it('anche il TITOLO è escaped', () => {
    const svg = renderChartSvg([{ label: 'a', value: 1 }], { ...opts('bar'), title: '<script>x</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});

describe('🔬 [BUG-BOUNTY] output sempre SVG VALIDO e NaN-free', () => {
  const datasets: Record<string, { label: unknown; value: unknown }[]> = {
    'valori non numerici': [{ label: 'a', value: 'NaN' }, { label: 'b', value: 'abc' }, { label: 'c', value: null }],
    'tutti negativi': [{ label: 'a', value: -5 }, { label: 'b', value: -10 }],
    'misti pos/neg': [{ label: 'a', value: 7 }, { label: 'b', value: -3 }],
    'tutti identici': [{ label: 'a', value: 7 }, { label: 'b', value: 7 }],
    'singolo punto': [{ label: 'solo', value: 42 }],
    'valore zero': [{ label: 'a', value: 0 }, { label: 'b', value: 0 }],
  };
  for (const [name, data] of Object.entries(datasets)) {
    it.each(ALL_TYPES)(`%s — ${name}: SVG valido, ZERO "NaN"/"undefined" nelle coordinate`, (type) => {
      const svg = renderChartSvg(data, opts(type));
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
      expect(svg, `${type}/${name} contiene NaN`).not.toContain('NaN');
      // niente attributi di coordinata con "undefined" (x="undefined" ecc.)
      expect(svg).not.toMatch(/(x|y|cx|cy|d|width|height)="[^"]*undefined/);
    });
  }
});

describe('renderChartSvg — correttezza per tipo', () => {
  const data = [{ label: 'Lun', value: 10 }, { label: 'Mar', value: 20 }, { label: 'Mer', value: 30 }];

  it('bar: una <rect> barra per punto (oltre allo sfondo)', () => {
    const svg = renderChartSvg(data, opts('bar'));
    const rects = (svg.match(/<rect /g) ?? []).length;
    expect(rects).toBe(1 + 3); // background + 3 barre
  });

  it('line: un <circle> per punto + un <path> linea', () => {
    const svg = renderChartSvg(data, opts('line'));
    expect((svg.match(/<circle /g) ?? []).length).toBe(3);
    expect(svg).toContain('<path d="M');
  });

  it('area: come line ma con path di riempimento (fill-opacity)', () => {
    expect(renderChartSvg(data, opts('area'))).toContain('fill-opacity="0.15"');
  });

  it('pie: una fetta <path> per punto + legenda', () => {
    const svg = renderChartSvg(data, opts('pie'));
    expect((svg.match(/<path d="M/g) ?? []).length).toBe(3);
  });

  it('pie con somma ≤ 0 → placeholder, non crash', () => {
    const svg = renderChartSvg([{ label: 'a', value: 0 }, { label: 'b', value: -5 }], opts('pie'));
    expect(svg).toContain('Nessun dato');
  });

  it('pie con una sola fetta 100% → cerchio pieno (l’arco non chiuderebbe)', () => {
    const svg = renderChartSvg([{ label: 'tutto', value: 50 }], opts('pie'));
    expect(svg).toContain('<circle');
    expect(svg).toContain('100%');
  });

  it('dati vuoti → placeholder "Nessun dato"', () => {
    expect(renderChartSvg([], opts('bar'))).toContain('Nessun dato');
  });
});

describe('svgToDataUri — round-trip', () => {
  it('decodifica base64 → SVG originale, mime image/svg+xml', () => {
    const svg = renderChartSvg([{ label: 'a', value: 1 }], opts('bar'));
    const uri = svgToDataUri(svg);
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(uri.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).toBe(svg);
  });
});
