/**
 * Quello che spetta all'utente non deve far fallire la generazione.
 *
 * Il 2026-08-04 la faceva fallire: l'id del database e la password della PEC
 * venivano bocciati con gravità critica, e critico vuol dire «riprovando può
 * andare meglio». Riprovare non poteva servire a niente — alla seconda e alla
 * terza generazione il modello continuava a non sapere quale fosse il
 * database dell'utente. Tre generazioni complete, oltre cinque minuti, per
 * finire con un errore che nessun tentativo poteva evitare.
 *
 * @module features/workflows/scaffold/repair-risorse.test
 */

import { describe, expect, it } from 'vitest';

import { PENDING_SECRET, PICKER_PLACEHOLDER } from '../constants';
import type { NodeDef } from '../types';

import type { RepairLog } from './repair';
import { riparaIdRisorse } from './repair-risorse';
import type { ScaffoldOutput } from './schema';

const CATALOGO = new Map<string, NodeDef>([
  [
    'db_insert',
    {
      defId: 'db_insert',
      configFields: [
        { key: 'databaseId', type: 'db-picker', required: true },
        { key: 'fuso', type: 'timezone-picker', required: false },
      ],
    } as NodeDef,
  ],
  [
    'italia_pec_aruba_receive',
    {
      defId: 'italia_pec_aruba_receive',
      configFields: [
        { key: 'username', type: 'text', required: true },
        { key: 'password', type: 'secret', required: true },
        { key: 'note', type: 'secret', required: false },
      ],
    } as NodeDef,
  ],
]);

function esegui(defId: string, config: Record<string, unknown>) {
  const output = { nodes: [{ id: 'n1', defId, config }], edges: [] } as unknown as ScaffoldOutput;
  const log: RepairLog = { applied: [] };
  const toccati = riparaIdRisorse(output, CATALOGO, log);
  const nodo = output.nodes[0];
  if (!nodo) throw new Error('il nodo di prova è sparito');
  return { config: nodo.config, toccati, log };
}

describe('gli id di risorsa copiati dal catalogo', () => {
  it('🚨 «db-picker» diventa il segnaposto del menu, non un errore critico', () => {
    // Il modello legge «databaseId:db-picker(REQUIRED)» e copia il tipo
    // credendolo un valore.
    const { config, toccati } = esegui('db_insert', { databaseId: 'db-picker' });
    expect(config.databaseId).toBe(PICKER_PLACEHOLDER);
    expect(toccati).toBe(1);
  });

  it('🚨 un id vero non si tocca: cancellarlo sarebbe un danno', () => {
    const vero = '3f9a1c2e-4b5d-6789-a0b1-c2d3e4f5a6b7';
    expect(esegui('db_insert', { databaseId: vero }).config.databaseId).toBe(vero);
  });

  it('🚨 «Europe/Rome» resta: il fuso il modello lo sa davvero', () => {
    // Il criterio «non sembra un UUID» avrebbe cancellato una risposta giusta
    // per sostituirla con un campo da riempire a mano.
    expect(esegui('db_insert', { fuso: 'Europe/Rome' }).config.fuso).toBe('Europe/Rome');
  });

  it('un’espressione si risolve a runtime e non è inventata', () => {
    const espr = '{{ $node.prima.databaseId }}';
    expect(esegui('db_insert', { databaseId: espr }).config.databaseId).toBe(espr);
  });
});

describe('i segreti che spetta all’utente configurare', () => {
  it('🚨 una password obbligatoria mancante diventa «da configurare»', () => {
    // Era il motivo per cui «archivia le PEC» falliva sempre.
    const { config } = esegui('italia_pec_aruba_receive', {});
    expect(config.password).toBe(PENDING_SECRET);
  });

  it('una password già scritta non viene sostituita', () => {
    const { config } = esegui('italia_pec_aruba_receive', { password: 'quella-giusta' });
    expect(config.password).toBe('quella-giusta');
  });

  it('un segreto facoltativo resta vuoto: non c’è niente da configurare', () => {
    expect(esegui('italia_pec_aruba_receive', {}).config.note).toBeUndefined();
  });

  it('dice quanti campi restano da completare, che non è «tutto a posto»', () => {
    const { toccati, log } = esegui('italia_pec_aruba_receive', {});
    expect(toccati).toBe(1);
    expect(log.applied[0]).toContain('prima di attivare');
  });
});
