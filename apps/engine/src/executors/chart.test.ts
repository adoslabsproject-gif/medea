import { describe, it, expect } from 'vitest';
import { chartGenerateExecutor, coerceChartData } from './chart.js';
import { chartGenerateNode } from '@medea/engine-nodes-stdlib';

const ctx = {} as never;

describe('coerceChartData — normalizza qualsiasi forma di input', () => {
  it('array di oggetti → usa labelField/valueField', () => {
    expect(coerceChartData([{ k: 'A', v: 10 }, { k: 'B', v: 20 }], 'k', 'v'))
      .toEqual([{ label: 'A', value: 10 }, { label: 'B', value: 20 }]);
  });
  it('array di numeri → indice come label', () => {
    expect(coerceChartData([5, 9], 'label', 'value')).toEqual([{ label: 0, value: 5 }, { label: 1, value: 9 }]);
  });
  it('array di coppie [label, value]', () => {
    expect(coerceChartData([['Lun', 3], ['Mar', 7]], 'label', 'value'))
      .toEqual([{ label: 'Lun', value: 3 }, { label: 'Mar', value: 7 }]);
  });
  it('JSON string → parsata', () => {
    expect(coerceChartData('[{"label":"x","value":1}]', 'label', 'value')).toEqual([{ label: 'x', value: 1 }]);
  });
  it('non-array / JSON invalido / stringa vuota → [] (mai throw)', () => {
    expect(coerceChartData('{not json', 'label', 'value')).toEqual([]);
    expect(coerceChartData(42, 'label', 'value')).toEqual([]);
    expect(coerceChartData(null, 'label', 'value')).toEqual([]);
    expect(coerceChartData('', 'label', 'value')).toEqual([]);
  });
  it('oltre 500 punti → cappato a 500 (anti-DoS SVG gigante)', () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ label: i, value: i }));
    expect(coerceChartData(big, 'label', 'value')).toHaveLength(500);
  });
});

describe('chartGenerateExecutor', () => {
  it('genera output completo {svg,dataUri,imgTag,width,height,pointCount}', async () => {
    const r = await chartGenerateExecutor(
      { chartType: 'bar', dataJson: '[{"label":"A","value":10},{"label":"B","value":20}]', title: 'T' },
      undefined, ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(String(o.svg).startsWith('<svg')).toBe(true);
    expect(String(o.dataUri).startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(String(o.imgTag)).toContain('<img src="data:image/svg+xml;base64,');
    expect(o.pointCount).toBe(2);
    expect(o.width).toBe(800);
    expect(o.height).toBe(400);
  });

  it('🚨🚨 XSS: title con `"` non rompe l\'attributo alt dell\'imgTag (email HTML)', async () => {
    const r = await chartGenerateExecutor(
      { chartType: 'bar', dataJson: '[1,2]', title: '"><script>alert(1)</script>' },
      undefined, ctx,
    );
    const imgTag = String((r.output as Record<string, unknown>).imgTag);
    // niente tag/quote raw che escano dall'attributo: tutto escaped
    expect(imgTag).not.toContain('<script>');
    expect(imgTag).not.toContain('"><');
    expect(imgTag).toContain('&quot;'); // il `"` del title è escapato
    expect(imgTag).toContain('&lt;script&gt;');
  });

  it('width/height fuori range → clampati a [100,4000]', async () => {
    const r = await chartGenerateExecutor({ chartType: 'bar', dataJson: '[1,2]', width: '99999', height: '1' }, undefined, ctx);
    const o = r.output as Record<string, unknown>;
    expect(o.width).toBe(4000);
    expect(o.height).toBe(100);
  });

  it('chartType invalido → fallback a bar (mai crash)', async () => {
    const r = await chartGenerateExecutor({ chartType: 'hacker', dataJson: '[1,2,3]' }, undefined, ctx);
    expect(String((r.output as Record<string, unknown>).svg)).toContain('<rect');
  });

  it('dataJson assente → usa l’input del nodo', async () => {
    const r = await chartGenerateExecutor({ chartType: 'line' }, [{ label: 'a', value: 5 }], ctx);
    expect((r.output as Record<string, unknown>).pointCount).toBe(1);
  });

  it('dati vuoti → warning + placeholder, non errore', async () => {
    const r = await chartGenerateExecutor({ chartType: 'bar', dataJson: '[]' }, undefined, ctx);
    expect(r.warnings).toBeDefined();
    expect(String((r.output as Record<string, unknown>).svg)).toContain('Nessun dato');
  });
});

describe('🔒 [CONTRACT anti-drift] NodeDef ↔ executor: i campi config combaciano', () => {
  it('ogni config.X letto dall’executor è dichiarato come campo UI, e viceversa', () => {
    const declared = new Set(chartGenerateNode.def.configFields?.map((f) => f.key) ?? []);
    // chiavi che l’executor legge da config (vedi chart.ts)
    const readByExecutor = ['chartType', 'dataJson', 'labelField', 'valueField', 'title', 'width', 'height', 'palette', 'outputFormat'];
    for (const k of readByExecutor) {
      expect(declared.has(k), `campo "${k}" letto dall’executor ma NON dichiarato nel NodeDef`).toBe(true);
    }
    for (const k of declared) {
      expect(readByExecutor.includes(k), `campo "${k}" dichiarato nel NodeDef ma MAI letto dall’executor (morto)`).toBe(true);
    }
  });

  it('defId del nodo === chiave del registry executor', () => {
    expect(chartGenerateNode.def.id).toBe('action_generate_chart');
  });
});
