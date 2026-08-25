/**
 * `ESPRESSIONE_NON_RISOLVIBILE` — un campo scritto da solo dentro le graffe.
 *
 * Il 2026-08-06 il wizard ha consegnato «riassunto_serale» con `{{tldr}}` nel
 * testo di un messaggio e `{{firedAt}}` in una riga di database. I NOMI erano
 * giusti — `tldr` esce davvero da `agent_summarizer`, `firedAt` da
 * `trigger_cron`: i contratti di output stavano funzionando, e il modello
 * aveva smesso di inventarsi i campi. Mancava il prefisso.
 *
 * Senza `$node.` l'interprete non trova niente e mette **stringa vuota**, e non
 * solleva: il messaggio parte vuoto, la riga si scrive con metà campi bianchi,
 * e chi guarda dà la colpa alla posta. È il difetto peggiore da diagnosticare
 * perché tutto, a vederlo, sembra a posto.
 *
 * Sta qui e non nel gate del desktop perché il desktop interviene DOPO, quando
 * il workflow è già costruito: al massimo lo mostra all'utente. Il motore
 * invece rifiuta e rigenera, e il modello si corregge da solo — che è la
 * differenza fra segnalare un difetto e non produrlo.
 *
 * La regola è precisa per costruzione: segnala solo quando sa **chi** produce
 * quel campo, e quindi può dire esattamente come si riscrive. Una parola che
 * nessun nodo a monte dichiara si lascia passare — meglio tacere che mandare a
 * correggere qualcosa di giusto.
 *
 * @module services/ai-scaffold/rule-espressione-nuda
 */

import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import type { QualityGateInput, QualityIssue } from '@/services/ai-scaffold/quality-gate.js';

/** Ogni cosa fra doppie graffe. */
const ESPRESSIONE = /\{\{([^}]+)\}\}/g;

/** Un identificatore nudo: niente punti, niente parentesi, niente operatori. */
const IDENTIFICATORE_NUDO = /^\s*([A-Za-z_][\w]*)\s*$/;

/**
 * I nomi che nello scope esistono davvero (vedi `engine/interpreter.ts`).
 * Segnalarli manderebbe a «correggere» espressioni giuste.
 */
const RADICI_DELLO_SCOPE: ReadonlySet<string> = new Set([
  'input',
  'output',
  'ctx',
  'item',
  'index',
  'loop',
  'vars',
  'secrets',
]);

/** `defId` → i campi che quel nodo dichiara di produrre. Letto una volta. */
let contrattiCache: ReadonlyMap<string, ReadonlySet<string>> | null = null;

function contratti(): ReadonlyMap<string, ReadonlySet<string>> {
  contrattiCache ??= new Map(
    buildNodeCatalog().map((n) => [
      n.defId,
      new Set((n.outputContract?.fields ?? []).map((f) => f.name)),
    ]),
  );
  return contrattiCache;
}

/** Tutti i nodi che possono aver girato prima di questo. */
function antenati(nodeId: string, edges: QualityGateInput['edges']): Set<string> {
  const entranti = new Map<string, string[]>();
  for (const e of edges) entranti.set(e.to, [...(entranti.get(e.to) ?? []), e.from]);

  const visti = new Set<string>();
  const coda = [...(entranti.get(nodeId) ?? [])];
  while (coda.length > 0) {
    const corrente = coda.pop();
    if (corrente === undefined || visti.has(corrente)) continue;
    visti.add(corrente);
    coda.push(...(entranti.get(corrente) ?? []));
  }
  return visti;
}

/** Ogni testo dentro una configurazione, annidamenti compresi. */
function testiDi(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(testiDi);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(testiDi);
  return [];
}

export function checkEspressioneNuda(input: QualityGateInput): QualityIssue[] {
  const perDefId = contratti();
  const issues: QualityIssue[] = [];

  for (const node of input.nodes) {
    // Calcolati una volta per nodo, non una per espressione.
    let monte: Set<string> | null = null;

    for (const [field, val] of Object.entries(node.config)) {
      for (const testo of testiDi(val)) {
        if (!testo.includes('{{')) continue;

        for (const m of testo.matchAll(ESPRESSIONE)) {
          const nome = IDENTIFICATORE_NUDO.exec(m[1] ?? '')?.[1];
          if (nome === undefined || RADICI_DELLO_SCOPE.has(nome)) continue;

          monte ??= antenati(node.id, input.edges);
          const produttore = input.nodes.find(
            (altro) => monte?.has(altro.id) === true && perDefId.get(altro.defId)?.has(nome) === true,
          );
          if (!produttore) continue;

          issues.push({
            severity: 'critical',
            code: 'ESPRESSIONE_NON_RISOLVIBILE',
            nodeId: node.id,
            message:
              `Il campo "${field}" usa {{${nome}}}: il nome è giusto — lo produce ` +
              `"${produttore.id}" — ma da solo non si risolve e a runtime resta VUOTO, ` +
              `senza errori. Scrivi {{$node.${produttore.id}.json.${nome}}}.`,
          });
        }
      }
    }
  }
  return issues;
}

/** Solo per i test: il catalogo si legge una volta e resta. */
export const __test__ = {
  dimentica: (): void => {
    contrattiCache = null;
  },
};
