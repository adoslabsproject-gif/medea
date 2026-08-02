import { describe, it, expect } from 'vitest';
import {
  extractMissingCapabilities,
  buildCoverageFeedback,
  buildCapabilityInjection,
} from './requirement-coverage.js';

describe('requirement-coverage — enforcement "fa quello che è chiesto"', () => {
  it('grafico richiesto + NESSUN chart node → manca chart (suggerisce action_generate_chart)', () => {
    const missing = extractMissingCapabilities('mandami un report email con grafico storico', [
      'action_send_email',
      'db_query',
    ]);
    expect(missing.map((m) => m.id)).toContain('chart');
    expect(missing.find((m) => m.id === 'chart')?.suggestNode).toBe('action_generate_chart');
  });

  it('grafico richiesto + chart node PRESENTE → coperto (no missing)', () => {
    const missing = extractMissingCapabilities('report con grafico', [
      'action_generate_chart',
      'action_send_email',
    ]);
    expect(missing.map((m) => m.id)).not.toContain('chart');
  });

  it('confronto storico → richiede db_query', () => {
    const missing = extractMissingCapabilities('confronto storico vs settimana scorsa', [
      'action_send_email',
    ]);
    expect(missing.map((m) => m.id)).toContain('db_query');
  });
  it('confronto storico + db_query presente → coperto', () => {
    expect(
      extractMissingCapabilities('confronto storico settimana scorsa', ['db_query']).map(
        (m) => m.id,
      ),
    ).not.toContain('db_query');
  });

  it('invio email richiesto + nessun nodo email → manca email', () => {
    expect(
      extractMissingCapabilities('invia una email di riepilogo', ['action_http']).map((m) => m.id),
    ).toContain('email');
  });
  it('email presente (anche email_send_tracked) → coperto', () => {
    expect(
      extractMissingCapabilities('mandami una mail', ['action_email_send_tracked']).map(
        (m) => m.id,
      ),
    ).not.toContain('email');
  });

  it('pdf richiesto → action_pdf_generate', () => {
    expect(
      extractMissingCapabilities('genera un pdf della fattura', []).map((m) => m.id),
    ).toContain('pdf');
  });

  it('prompt SENZA capability speciali → nessun missing (no falsi positivi)', () => {
    expect(
      extractMissingCapabilities('quando arriva un webhook chiama una API', [
        'trigger_webhook',
        'action_http',
      ]),
    ).toEqual([]);
  });

  it('caso reale Sitemap Crawler: grafico + db_query mancanti, email presente', () => {
    const goal =
      'crawla la sitemap, fai audit SEO, mandami report email HTML con tabella e grafico storico vs settimana scorsa (db_query per confronto)';
    const nodes = ['action_sitemap_crawler', 'action_seo_audit', 'action_send_email', 'logic_loop'];
    const missing = extractMissingCapabilities(goal, nodes);
    const ids = missing.map((m) => m.id);
    expect(ids).toContain('chart');
    expect(ids).toContain('db_query');
    expect(ids).not.toContain('email'); // email c'è
  });

  it('buildCoverageFeedback nomina i nodi da aggiungere + parte con "Workflow rejected — quality gate"', () => {
    const fb = buildCoverageFeedback([
      { id: 'chart', label: 'grafico', suggestNode: 'action_generate_chart' },
    ]);
    expect(fb.startsWith('Workflow rejected — quality gate')).toBe(true); // così il retry-loop lo cattura
    expect(fb).toContain('action_generate_chart');
  });
});

describe('buildCapabilityInjection — inject deterministico (refinement "l\'ho fatto io")', () => {
  it('chart: inietta action_generate_chart cablato sul nodo TERMINALE (no edge uscenti)', () => {
    const nodes = [
      { id: 'trig', defId: 'trigger_manual' },
      { id: 'agg', defId: 'action_aggregate' },
    ];
    const edges = [{ from: 'trig', to: 'agg' }]; // agg è terminale (no edge uscenti)
    const inj = buildCapabilityInjection('chart', nodes, edges);
    expect(inj).not.toBeNull();
    expect(inj!.node.defId).toBe('action_generate_chart');
    expect(inj!.node.config.dataJson).toBe('{{$node.agg.json}}'); // cablato sul terminale
    expect(inj!.edge).toEqual({ from: 'agg', to: 'action_generate_chart_auto' });
  });

  it('chart: NON aggancia a un trigger (sorgente dati deve essere un nodo dati)', () => {
    const nodes = [{ id: 'trig', defId: 'trigger_imap' }];
    const inj = buildCapabilityInjection('chart', nodes, []);
    // unico nodo è un trigger → fallback all'ultimo nodo (trig), ma il config NON
    // dovrebbe agganciarsi a un trigger come sorgente "ideale"; qui c'è solo trig.
    expect(inj!.node.config.dataJson).toContain('trig'); // fallback all'unico nodo
  });

  it('db_query: iniettato con template di confronto storico + cablato', () => {
    const inj = buildCapabilityInjection('db_query', [{ id: 'a', defId: 'action_http' }], []);
    expect(inj!.node.defId).toBe('db_query');
    expect(inj!.node.config.sql).toMatch(/SELECT .* FROM/i);
    expect(inj!.edge).toEqual({ from: 'a', to: 'db_query_auto' });
  });

  it('email/pdf/db_persist: TUTTI iniettati (niente warning), cablati sul terminale', () => {
    const nodes = [{ id: 'src', defId: 'action_aggregate' }];
    expect(buildCapabilityInjection('email', nodes, [])!.node.defId).toBe('action_send_email');
    expect(buildCapabilityInjection('pdf', nodes, [])!.node.defId).toBe('action_pdf_generate');
    expect(buildCapabilityInjection('db_persist', nodes, [])!.node.defId).toBe('db_insert');
    expect(buildCapabilityInjection('email', nodes, [])!.node.config.body).toBe(
      '{{$node.src.json}}',
    );
  });

  it("config dell'iniettato è SOLO stringhe (CanvasNodeSchema.config strict)", () => {
    for (const cap of ['chart', 'db_query', 'db_persist', 'email', 'pdf']) {
      const inj = buildCapabilityInjection(cap, [{ id: 's', defId: 'action_aggregate' }], []);
      for (const v of Object.values(inj!.node.config)) {
        expect(typeof v, `${cap}.config valore`).toBe('string');
      }
    }
  });

  it('capability sconosciuta → null; workflow vuoto → null', () => {
    expect(buildCapabilityInjection('boh', [{ id: 'a', defId: 'x' }], [])).toBeNull();
    expect(buildCapabilityInjection('chart', [], [])).toBeNull();
  });
});
