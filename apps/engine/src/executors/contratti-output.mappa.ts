/**
 * Dove sta il codice che produce l'output di un nodo.
 *
 * Non è una mappa scritta a mano: la si ricava da `registry.ts`, che è
 * l'autorità su chi esegue cosa. Il registro dice `defId → funzione`, gli
 * `import` dicono `funzione → file`. Tenere accanto un secondo elenco di 160
 * righe voleva dire vederlo andare fuori sincrono al primo nodo spostato — e
 * un controllo fuori sincrono è un controllo che non controlla.
 *
 * Per i nodi senza override lato server l'executor sta nel pacchetto, accanto
 * alla definizione: lì si guarda la cartella del nodo.
 *
 * @module executors/contratti-output.mappa
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { NodeDef } from '@medea/engine-core-schema';

/** La radice del repository, da cui partono tutti i percorsi. */
const RADICE = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * I nodi il cui output non si può confrontare con un sorgente, e perché.
 *
 * Non è una scappatoia: sono i casi in cui i nomi dei campi li decide chi usa
 * il workflow, non chi lo esegue. `trigger_form` consegna il modulo compilato,
 * `trigger_manual` quello che si scrive nella finestra di avvio.
 */
export const NON_CONFRONTABILI: ReadonlySet<string> = new Set([
  'trigger_form',
  'trigger_manual',
]);

/**
 * Sorgenti aggiuntive, per i nodi il cui payload nasce in più punti.
 *
 * Il caso tipico è un trigger che riusa un poller altrui e vi aggiunge
 * qualcosa: il rimbalzo esce dal poller IMAP, ma il rapporto DSN glielo mette
 * il `messageGate` montato dal servizio, e i campi di quel rapporto nascono nel
 * parser. Tre file, tre pezzi dello stesso payload.
 */
const SORGENTI_EXTRA: Record<string, readonly string[]> = {
  // I nodi di diramazione non hanno un executor: il loro output nasce in una
  // STRATEGIA del motore, perché la scelta del ramo è una faccenda del motore
  // e non del nodo. Cercarli fra gli executor non li trovava.
  logic_if: ['apps/engine/src/engine/strategies/logic-if.strategy.ts'],
  logic_switch: ['apps/engine/src/engine/strategies/logic-switch.strategy.ts'],
  logic_delay: ['apps/engine/src/engine/strategies/logic-delay.strategy.ts'],
  trigger_imap: ['apps/engine/src/services/trigger-watchers/imap-poller.ts'],
  trigger_cron: ['apps/engine/src/services/scheduler.service.ts'],
  trigger_webhook: ['apps/engine/src/routes/webhooks.ts'],
  trigger_kafka: ['apps/engine/src/services/trigger-watchers/kafka-watcher.ts'],
  trigger_rabbitmq: ['apps/engine/src/services/trigger-watchers/rabbitmq-watcher.ts'],
  trigger_websocket: ['apps/engine/src/services/trigger-watchers/websocket-watcher.ts'],
  trigger_file_watch: ['apps/engine/src/services/trigger-watchers/file-watcher.ts'],
  trigger_db_change: ['apps/engine/src/services/trigger-watchers/db-change-poller.ts'],
  trigger_odoo_polling: ['apps/engine/src/services/trigger-watchers/odoo-poller.ts'],
  trigger_error: ['apps/engine/src/services/error-outbox/error-handler-starter.ts'],
  trigger_telegram: ['apps/engine/src/routes/telegram-trigger/normalize.ts'],
  trigger_whatsapp: ['apps/engine/src/routes/whatsapp-trigger/normalize.ts'],
  italia_pec_aruba_receive: ['apps/engine/src/executors/pec/pec-message.ts'],
  trigger_email_bounce: [
    'apps/engine/src/services/trigger-watchers/imap-poller.ts',
    'apps/engine/src/services/trigger-watchers.service.ts',
    'apps/engine/src/services/trigger-watchers/bounce-parser.ts',
  ],
};

/** Il registro, letto una volta sola: `defId → nome della funzione`. */
const registro = (): ReadonlyMap<string, string> => {
  const testo = readFileSync(join(RADICE, 'apps/engine/src/executors/registry.ts'), 'utf8');
  const m = new Map<string, string>();
  for (const riga of testo.matchAll(/^\s*(?:'([\w.]+)'|(\w+)):\s*([\w.]+),/gm)) {
    const id = riga[1] ?? riga[2];
    const fn = riga[3];
    if (id !== undefined && fn !== undefined) m.set(id, fn);
  }
  return m;
};

/** Gli `import` del registro: `nome esportato → file che lo definisce`. */
const importazioni = (): ReadonlyMap<string, string> => {
  const testo = readFileSync(join(RADICE, 'apps/engine/src/executors/registry.ts'), 'utf8');
  const m = new Map<string, string>();
  for (const imp of testo.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const nomi = imp[1];
    const da = imp[2];
    if (nomi === undefined || !da?.startsWith('.')) continue;
    // `./x.js` in sorgente è `./x.ts` su disco.
    const file = join('apps/engine/src/executors', da.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
    for (const n of nomi.split(',')) {
      const netto = n.trim().split(/\s+as\s+/)[0]?.trim();
      if (netto) m.set(netto, file);
    }
  }
  return m;
};

const REGISTRO = registro();
const IMPORT = importazioni();

/** Tutti i file `.ts` di una cartella e delle sue sottocartelle, test esclusi. */
function sorgentiIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sorgentiIn(p));
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/** I pacchetti in cui possono stare le definizioni dei nodi. */
const PACCHETTI = [
  'stdlib',
  'db',
  'ai-agents',
  'llm',
  'integrations-core',
  'integrations-italia',
] as const;

/**
 * Il file del pacchetto che dichiara questo nodo, se c'è.
 *
 * Si guarda prima la forma esplicita `id: '<nodo>'`. Alcuni nodi però non la
 * scrivono: i cinque `ai_*` nascono da `makeLlmNode('ai_openai', …)`, dove l'id
 * è un argomento. Per quelli si ripiega sull'id fra apici — meno preciso, ma è
 * la differenza fra controllarli e non controllarli affatto.
 */
function fileDelPacchetto(defId: string): string[] {
  for (const forma of [`id: '${defId}'`, `'${defId}'`]) {
    for (const pkg of PACCHETTI) {
      for (const f of sorgentiIn(join(RADICE, 'packages/engine/nodes', pkg, 'src'))) {
        if (readFileSync(f, 'utf8').includes(forma)) {
          // Tutta la cartella del nodo: definizione ed executor stanno separati.
          return sorgentiIn(join(f, '..'));
        }
      }
    }
  }
  return [];
}

/**
 * I file in cui cercare i campi che un nodo dichiara di produrre.
 *
 * Si mettono insieme l'override lato server (se c'è), il pacchetto che lo
 * dichiara, e le sorgenti extra per i payload che nascono altrove.
 */
export function sorgentiExecutor(defId: string): readonly string[] {
  const out = new Set<string>();
  const fn = REGISTRO.get(defId);
  if (fn) {
    const f = IMPORT.get(fn);
    if (f) out.add(join(RADICE, f));
  }
  for (const f of fileDelPacchetto(defId)) out.add(f);
  for (const f of SORGENTI_EXTRA[defId] ?? []) out.add(join(RADICE, f));
  return [...out];
}

/** Tutte le definizioni note, da tutti i pacchetti di nodi. */
export function allNodeDefs(): readonly NodeDef[] {
  const cat = JSON.parse(
    readFileSync(
      join(RADICE, 'apps/desktop/src/features/workflows/catalog/stdlib-nodes.json'),
      'utf8',
    ),
  ) as { defId: string; outputContract?: NodeDef['outputContract'] }[];
  return cat.map((n) => ({ id: n.defId, ...n }) as unknown as NodeDef);
}
