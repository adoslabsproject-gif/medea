import type { NodeModule, NodeExecutor } from '../types.js';
import { readJsonCapped, readTextTruncated } from '@medea/engine-safe-fetch';

// Isomorfico: importato anche dal bundle browser dell'editor (dead-code lì, ma
// il top-level gira a load). `process` esiste solo sul runtime server → guard.
const RUNTIME_BASE =
  (typeof process !== 'undefined' ? process.env.MEDEA_RUNTIME_URL : undefined) ??
  'http://127.0.0.1:3100';

/**
 * N17 audit (2026-05-29): anti-recursion-bomb cap.
 *
 * A subworkflow can call another subworkflow, which can call another...
 * Without a depth cap, A→B→A or A→A is a single-tenant DoS:
 *  - fd exhausted (1 HTTP connection per level)
 *  - SQLite `runs` table fills disk
 *  - CPU 100% on dispatch + engine eval
 *
 * 10 is a comfortable cap: real workflows nest 2-3 deep at most. If
 * legitimately needed deeper, raise via env override (operator decision).
 */
const MAX_SUBWORKFLOW_DEPTH = Number(
  (typeof process !== 'undefined' ? process.env.MEDEA_MAX_SUBWORKFLOW_DEPTH : undefined) ?? 10,
);

/**
 * Fix 2026-08-01: `wait` non aspettava.
 *
 * `POST /workflows/:id/run` risponde 202 appena la run è in coda — è
 * asincrono di proposito, per non morire dietro il timeout di nginx sui
 * workflow lunghi. Questo esecutore leggeva quella risposta e la restituiva
 * come risultato: il parent riceveva `status: running` e zero step, cioè
 * un'esecuzione appena nata invece dell'output del sub.
 *
 * La descrizione del nodo promette «await fino al completamento del sub», e
 * chi costruisce un flusso che legge quel risultato lo cerca ovunque tranne
 * che nel significato della parola. Quindi si aspetta davvero: si interroga
 * `GET /runs/:id` finché la run non è in uno stato terminale.
 *
 * Il tetto al tempo di attesa esiste perché un sub che non finisce mai
 * bloccherebbe il parent per sempre — e con esso uno slot di esecuzione.
 * Superato il tetto si fallisce dichiarandolo: chi vuole proseguire lo stesso
 * ha `continueOnFail`.
 */
function waitTimeoutMs(): number {
  // Letto a ogni chiamata e non una volta sola all'avvio: un operatore che
  // alza il tetto vuole che valga, non che valga al prossimo riavvio.
  return Number(
    (typeof process !== 'undefined' ? process.env.MEDEA_SUBWORKFLOW_WAIT_TIMEOUT_MS : undefined) ??
      600_000,
  );
}

/** Gli stati in cui una run ha finito di muoversi. */
const TERMINAL = new Set(['success', 'error', 'partial', 'cancelled', 'paused']);

/** Attesa fra un'interrogazione e l'altra: parte fitta, si allarga. */
const POLL_START_MS = 150;
const POLL_MAX_MS = 2_000;

const subworkflowExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const workflowId = typeof config.workflowId === 'string' ? config.workflowId : '';
  if (!workflowId) throw new Error('subworkflow: missing workflowId');

  // SECURITY: workflowId è config dell'autore e viene interpolato in un URL verso
  // l'API INTERNA con X-Internal-Token (privilegiato). Senza validazione, un
  // valore come `../internal/egress` normalizzerebbe il path e colpirebbe endpoint
  // interni col token interno (privilege escalation). Allowlist stretta (formato
  // reale degli id = nanoid/UUID) + encodeURIComponent nell'URL (difesa-in-profondità).
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) {
    throw new Error('subworkflow: workflowId non valido (ammessi solo lettere, numeri, - e _)');
  }

  // N17 audit: self-recursion guard (cheapest case — same workflow id).
  // A→B→A indirect cycles are caught by the depth cap below.
  if (workflowId === context.workflowId) {
    throw new Error('subworkflow: self-recursion not allowed (workflow cannot invoke itself)');
  }

  // N17 audit: depth cap. Engine populates context.subworkflowDepth from
  // the X-Subworkflow-Depth header on the inbound run request.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
  const depth = Number(context.subworkflowDepth ?? 0);
  if (depth >= MAX_SUBWORKFLOW_DEPTH) {
    throw new Error(
      `subworkflow: max recursion depth ${String(MAX_SUBWORKFLOW_DEPTH)} exceeded (current depth ${String(depth)})`,
    );
  }

  const wait = config.wait !== 'false';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': context.tenantId,
    // N17: propagate +1 to the nested run. The receiving runtime reads
    // this header in routes/runs.ts and seeds the nested NodeExecutionContext.
    'X-Subworkflow-Depth': String(depth + 1),
  };
  const internalToken = process.env.MEDEA_INTERNAL_TOKEN;
  if (internalToken) headers['X-Internal-Token'] = internalToken;
  const res = await fetch(
    `${RUNTIME_BASE}/api/v1/workflows/${encodeURIComponent(workflowId)}/run`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ triggerInput: input, triggerType: 'subworkflow' }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `subworkflow ${String(res.status)}: ${(await readTextTruncated(res, 8192)).text.slice(0, 400)}`,
    );
  }
  // anti-OOM: fetch raw verso il runtime interno → cap esplicito (un run con
  // output enorme non deve bufferizzare senza limite nel container).
  const body = await readJsonCapped<{
    run: { runId: string; status: string; steps: unknown[]; totalDurationMs: number };
  }>(res);

  if (!wait) {
    return { output: { runId: body.run.runId, started: true }, durationMs: Date.now() - start };
  }

  // ── Aspettare davvero ────────────────────────────────────────────────
  const runId = body.run.runId;
  let attesa = POLL_START_MS;
  const tetto = waitTimeoutMs();
  const scadenza = Date.now() + tetto;

  while (Date.now() < scadenza) {
    await new Promise((r) => setTimeout(r, attesa));
    attesa = Math.min(attesa * 2, POLL_MAX_MS);

    const check = await fetch(`${RUNTIME_BASE}/api/v1/runs/${encodeURIComponent(runId)}`, {
      headers,
    });
    if (!check.ok) {
      throw new Error(
        `subworkflow: non riesco a seguire la run ${runId} (${String(check.status)})`,
      );
    }
    // Attenzione al nome: il dispatch risponde `runId`, la lettura di una run
    // la chiama `id`. Leggere il campo sbagliato non fallisce — restituisce
    // `undefined`, e il parent riceve un risultato senza identificativo.
    const stato = await readJsonCapped<{
      run: {
        id?: string;
        runId?: string;
        status: string;
        steps: unknown[];
        totalDurationMs: number;
      };
    }>(check);
    if (!TERMINAL.has(stato.run.status)) continue;

    return {
      output: {
        runId: stato.run.id ?? stato.run.runId ?? runId,
        status: stato.run.status,
        steps: stato.run.steps,
        durationMs: stato.run.totalDurationMs,
      },
      durationMs: Date.now() - start,
    };
  }

  // Il sub sta ancora girando: si fallisce dichiarandolo, invece di
  // restituire un risultato che non c'è. Chi vuole proseguire lo stesso ha
  // `continueOnFail`.
  throw new Error(
    `subworkflow: il sub-workflow non ha finito entro ${String(Math.round(tetto / 1000))}s (run ${runId}, ancora in corso)`,
  );
};

export const subworkflowNode: NodeModule = {
  def: {
    id: 'logic_subworkflow',
    type: 'logic',
    label: 'Subworkflow',
    icon: 'corner-down-right',
    color: '#f59e0b',
    description:
      'Operatore enterprise di composizione workflow-as-function — il pattern fondamentale di modularizzazione ' +
      'che permette di chiamare un altro workflow del tenant come fosse uno step del workflow corrente, ' +
      "l'equivalente di una funzione nella programmazione classica. Invoca un sub-workflow target (identificato " +
      "via workflowId selezionato dal picker della UI editor) passando l'output dello step upstream come input " +
      "al sub, ed il return value del sub-workflow diventa l'output del nodo logic_subworkflow nel parent — " +
      'pattern transparent che permette di astrarre logica condivisa in un mini-workflow riusabile in N posti. ' +
      'Esecuzione sincrona di default (await fino al completamento del sub) — il workflow parent blocca su ' +
      'questo step finché il sub non ritorna (anche se gira per ore per task long-running come ETL nightly). ' +
      'Opzione asincrona fire-and-forget configurable: lancia il sub e prosegue immediatamente con runId del ' +
      'sub come output — pattern per orchestrazione di N children parallel senza dover aspettarli tutti (es. ' +
      'master workflow che lancia 50 children "process customer" in parallelo e prosegue alla aggregation ' +
      'step dopo che tutti hanno emit signal completed). ' +
      'Anti-loop guard enterprise multi-livello: self-recursion detection (workflow A che chiama A → block ' +
      'immediato con errore semantico esplicito "self-recursion detected"), depth-cap configurable via env ' +
      'MEDEA_MAX_SUBWORKFLOW_DEPTH (default 10 — il valore comfortable per il pattern enterprise di ' +
      'nesting ragionevole; oltre serve override esplicito operatore per evitare resource exhaustion); ' +
      "propagation della depth via X-Subworkflow-Depth header tra parent→child HTTP run dispatch — l'engine " +
      'incrementa di +1 ad ogni nested call e block se cap raggiunto, prevenendo recursion-bomb attack o ' +
      'workflow malformati con cycle indiretto. ' +
      'Tenant isolation: il sub-workflow DEVE appartenere allo stesso tenant del parent (non possiamo chiamare ' +
      'workflow di altri tenant — multi-tenant security boundary), enforce a livello del runtime via tenantId ' +
      'check. ' +
      'Use case classici di modularizzazione: estrarre logica condivisa "send-notification-email" usata da 20 ' +
      'workflow diversi del tenant — invece di copy-paste della sequence Sentinel + audit + render + send in ' +
      'ognuno, creo un sub "notification" riusato in tutti; orchestrare workflow gerarchici master → children ' +
      '(es. master nightly batch che lancia 10 children paralleli per ognuno dei tenant del SaaS managed); ' +
      'modularizzare workflow grossi in mini-workflow indipendenti (un workflow "onboarding cliente" decomposto ' +
      'in 5 sub: validate_form, create_user, provision_resources, send_welcome_email, schedule_followup_call — ' +
      'ciascuno testabile e maintainable separatamente); pattern Strategy programmation con sub-workflow ' +
      'configurati dinamicamente in base al tipo di evento upstream (logic_switch → 5 logic_subworkflow ' +
      'diversi per 5 type di evento gestiti); DRY refactoring di workflow legacy con duplicazione enorme di ' +
      'logica in un canonical sub.',
    configFields: [
      {
        key: 'workflowId',
        label: 'Sub-workflow da invocare',
        type: 'workflow-picker',
        required: true,
        help: "Workflow del tenant (esclusi il corrente). L'output del nodo precedente diventa l'input del sub-workflow.",
      },
      {
        key: 'wait',
        label: 'Attendi completamento',
        type: 'select',
        options: ['true', 'false'],
        defaultValue: 'true',
        required: false,
        help: "true = aspetta la fine e ricevi l'output. false = fire-and-forget, ritorna subito con runId del sub-workflow.",
      },
    ],
    outputContract: {
      notes: 'Due forme diverse a seconda dell\'attesa. Senza attendere escono solo `runId` e `started`; attendendo escono `runId`, `status`, `steps` e `durationMs` — e `started` NON c\'e`.',
      fields: [
        { name: 'runId', type: 'string', desc: 'L\'esecuzione avviata, per ritrovarla nello storico.' },
        { name: 'started', type: 'boolean', desc: 'Sempre true, e presente SOLO quando il nodo non aspetta la fine.' },
        { name: 'status', type: 'string', desc: 'Come e` finita: succeeded, failed o cancelled. Presente solo attendendo.' },
        { name: 'steps', type: 'array', desc: 'I passi eseguiti dal sotto-workflow, uno per nodo. Presente solo attendendo.' },
        { name: 'durationMs', type: 'number', desc: 'Quanto e` durata l\'intera esecuzione figlia. Presente solo attendendo.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: subworkflowExecutor,
};
