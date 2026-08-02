/**
 * GUARD anti-facciata — ogni nodo bundlato del catalogo DEVE avere un executor.
 *
 * Perché esiste (istituzionalizzazione, 2026-07-03): a runtime l'esecuzione di
 * un nodo risolve l'implementazione così (engine/strategies/node-executor.
 * strategy.ts:85):
 *
 *     const exec = resolveServerExecutor(def.id) ?? module.executor;
 *     if (!exec) → SKIP  { skipped: "… has no executor in this runtime version" }
 *
 * Un nodo che appare nel catalogo/palette ma non ha NÉ un override runtime
 * (`serverExecutors[id]`) NÉ un `module.executor` nel package è quindi una
 * FACCIATA: l'utente lo trascina nel workflow, parte, e non fa NULLA. Questo
 * test replica ESATTAMENTE quella condizione su tutti i pacchetti bundlati e
 * fallisce elencando le facciate → impossibile aggiungerne di nuove in silenzio.
 *
 * Usa `serverExecutors` (mappa statica, own-property) invece di
 * `resolveServerExecutor` di proposito: quest'ultimo, per i nodi non mappati,
 * interroga anche l'indice community/custom (side-effect su storage) — qui
 * vogliamo un check PURO sul catalogo bundlato, senza dipendenze runtime.
 *
 * I trigger (`type === 'trigger'`) sono esclusi: non passano da
 * node-executor.strategy (li avvia il trigger system), quindi l'invariante
 * "executor presente" non li riguarda.
 */
import { describe, it, expect } from 'vitest';
import { serverExecutors } from './registry.js';
import { stdlibNodes } from '@medea/engine-nodes-stdlib';
import { dbNodes } from '@medea/engine-nodes-db';
import { coreIntegrationNodes } from '@medea/engine-nodes-integrations-core';
import { italianConnectors } from '@medea/engine-nodes-integrations-italia';
import { aiAgentNodes } from '@medea/engine-nodes-ai-agents';
import { llmNodes } from '@medea/engine-nodes-llm';
import type { NodeModule } from '@medea/engine-nodes-stdlib';

const CATALOG: NodeModule[] = [
  ...stdlibNodes,
  ...dbNodes,
  ...coreIntegrationNodes,
  ...italianConnectors,
  ...aiAgentNodes,
  ...llmNodes,
];

/**
 * Primitive di controllo di flusso: NON hanno executor by-design perché
 * l'engine le intercetta PRIMA del catch-all NodeExecutorStrategy —
 * if/switch/delay via DEFAULT_DISPATCH_STRATEGIES (strategies/index.ts),
 * loop/wait_signal via special-casing nel workflow-engine
 * (workflow-engine.ts:952). Sono un insieme piccolo e stabile (le primitive
 * del linguaggio workflow). Il test "ancora" più sotto verifica che questo
 * Set resti allineato alla realtà: se un control-flow sparisce o gli viene
 * aggiunto un executor, il test lo segnala → nessun drift silenzioso.
 */
const ENGINE_CONTROL_FLOW = new Set<string>([
  'logic_if', 'logic_switch', 'logic_loop', 'logic_delay', 'logic_wait_signal',
]);

/** Replica la risoluzione runtime, senza toccare community/custom. */
function hasExecutor(m: NodeModule): boolean {
  return Object.hasOwn(serverExecutors, m.def.id) || typeof m.executor === 'function';
}

/** Un nodo NON richiede executor se è un trigger o una primitiva di flusso. */
function engineHandled(m: NodeModule): boolean {
  return m.def.type === 'trigger' || m.def.id.startsWith('trigger_') || ENGINE_CONTROL_FLOW.has(m.def.id);
}

describe('catalog executor coverage — nessuna facciata', () => {
  it('il catalogo bundlato non è vuoto (guardia contro import rotti)', () => {
    expect(CATALOG.length).toBeGreaterThan(120);
  });

  it('🚨 ogni nodo-azione ha un executor risolvibile (server override o module.executor)', () => {
    const facciate = CATALOG
      .filter((m) => !engineHandled(m))
      .filter((m) => !hasExecutor(m))
      .map((m) => `${m.def.id} (${m.def.type})`);
    expect(facciate, `FACCIATE — nodi nel catalogo SENZA executor: ${facciate.join(', ')}`).toEqual([]);
  });

  it('🚨 ANCORA: ogni primitiva di flusso esiste nel catalogo E non ha executor (no drift del Set)', () => {
    for (const id of ENGINE_CONTROL_FLOW) {
      const m = CATALOG.find((n) => n.def.id === id);
      expect(m, `control-flow "${id}" non è più nel catalogo — aggiorna ENGINE_CONTROL_FLOW`).toBeDefined();
      // Se un giorno una primitiva ottiene un executor reale, va TOLTA dal Set
      // (non è più "engine-handled puro"): questo assert lo forza a emergere.
      expect(hasExecutor(m!), `"${id}" ora HA un executor → rimuovilo da ENGINE_CONTROL_FLOW`).toBe(false);
    }
  });

  it('nessun id duplicato tra i pacchetti bundlati (collisione → executor sbagliato)', () => {
    const ids = CATALOG.map((m) => m.def.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect([...new Set(dupes)], `id duplicati: ${dupes.join(', ')}`).toEqual([]);
  });
});

// ── Contratto esplicito sui nodi richiesti dall'owner (Excel/WhatsApp/
//    Telegram/Webscraping/Python-JS-TS/PDF/Gmail): NON sono facciate. ──────
describe('nodi richiesti — executor reale (anti-facciata mirato)', () => {
  const REQUIRED: { id: string; label: string }[] = [
    { id: 'action_xlsx_parse', label: 'Excel parse' },
    { id: 'action_xlsx_build', label: 'Excel build' },
    { id: 'action_whatsapp_send', label: 'WhatsApp' },
    { id: 'integration_telegram_send', label: 'Telegram' },
    { id: 'action_scrape_smart', label: 'Webscraping (scrape smart)' },
    { id: 'action_run_python', label: 'Run Python' },
    { id: 'action_run_js', label: 'Run JavaScript' },
    { id: 'action_run_ts', label: 'Run TypeScript' },
    { id: 'action_pdf_parse', label: 'PDF parse' },
    { id: 'action_pdf_generate', label: 'PDF generate' },
    { id: 'action_gmail', label: 'Gmail' },
  ];

  it.each(REQUIRED)('$label ($id) esiste nel catalogo ed ha un executor', ({ id }) => {
    const m = CATALOG.find((n) => n.def.id === id);
    expect(m, `${id} deve essere nel catalogo bundlato`).toBeDefined();
    expect(hasExecutor(m!), `${id} deve avere un executor (server o module)`).toBe(true);
  });
});
