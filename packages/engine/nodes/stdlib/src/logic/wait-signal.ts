import type { NodeModule } from '../types.js';

/**
 * Wait For Signal — pause the workflow until an external event arrives.
 *
 * This is the killer-feature for BPMN-style workflows: contracts, approvals,
 * "wait for customer to upload doc", long-running compliance flows.
 *
 * When the engine encounters this node, it does NOT block the process.
 * Instead it:
 *   1. Persists the entire run state (outputs, visited, queue, loop ctx)
 *      to the `paused_workflows` table.
 *   2. Returns immediately — the request that triggered the run completes.
 *   3. Sometime later (could be days/weeks), an external call to
 *      POST /api/v1/signals/:signalName fires.
 *   4. The SignalService finds the paused row, restores state, and the
 *      engine resumes from the node AFTER wait_signal, with the signal
 *      payload as the carried input.
 *
 * Timeout policy: when `timeoutSeconds` elapses without a signal, the
 * janitor fires the resume with `defaultPayload`, so the workflow doesn't
 * hang forever.
 *
 * Execution is HANDLED IN THE ENGINE — there is no executor here. The
 * engine intercepts this node id specifically (like logic_loop).
 */
export const waitSignalNode: NodeModule = {
  def: {
    id: 'logic_wait_signal',
    type: 'logic',
    label: 'Wait For Signal',
    icon: 'hourglass',
    color: '#a855f7',
    description:
      "Operatore di pausa event-driven enterprise che sospende l'esecuzione del workflow fino all'arrivo di un " +
      'segnale esterno via HTTP — il pattern signal-and-wait classico di Temporal/Cadence Workflows e workflow ' +
      'orchestration enterprise, fondamento di tutti i processi long-running con interazione umana o coordinamento ' +
      'asincrono con sistemi esterni dove il tempo di attesa è ore-giorni-settimane (non secondi come logic_delay). ' +
      'Implementazione resilient: il run state completo (variables, step history, expression context) viene ' +
      'persistito nel checkpoint del SQLite runtime tenant in stato `paused_waiting_signal`, il workflow ' +
      'continua a contare nelle quote dei workflow attivi ma non consuma CPU/RAM mentre attende. Il signal ' +
      'arriva via POST `<tenant>.app.automazionezeli.com/signals/<signal_name>` con payload JSON opzionale — ' +
      'il portal scheduler intercetta, verifica permessi (signal_token segreto del workflow se signalRequiresAuth) ' +
      'e firma il resume del workflow da dove era stato sospeso. ' +
      'Sopravvive a TUTTO: restart container per deploy, crash del runtime, migrazione tra host fisici, ' +
      'pausa idle del container con wake-on-signal automatico, upgrade major version del runtime image. La ' +
      'pausa può durare letteralmente settimane senza degradation perché lo state vive in disco persistente, ' +
      'non in memoria volatile. Cap di sicurezza: timeoutMs configurabile (default 30 giorni, max 90gg) dopo ' +
      'il quale il workflow riprende con status `signal_timeout` e branch fallback eventualmente collegato. ' +
      'Match opzionale su payload via expression: invece di accettare CUALQUIER signal con name matching, è ' +
      'possibile filtrare ulteriormente con un\'expression JavaScript-like (es. "$.payload.userId === ' +
      'currentUser && $.payload.action === \'approve\'") che decide se questo signal è quello "giusto" per ' +
      'questo specifico run sospeso — pattern critico in scenari multi-run sospesi simultaneamente sullo ' +
      'stesso signal name dove serve discriminare. ' +
      'Output al resume: { signal_payload (intera JSON del POST body del signal), receivedAt (ISO timestamp), ' +
      'pausedDuration (ms tra pause e resume per metrics SLA) }. ' +
      'Use case: workflow approvazione fattura sopra una certa soglia (€10k+) che attende click del manager su ' +
      'pulsante "Approve" o "Reject" nell\'inbox email (il button è un link al endpoint signal con UUID firmato ' +
      'embedded), pausa media 24-48h business hours; onboarding multi-step di un nuovo cliente B2B con conferma ' +
      'email (envia email link → user click link → signal received → workflow continua con setup automatic ' +
      'workspace + access provisioning), pausa media 1-3 giorni; processo legale con SLA giorni-settimane di ' +
      'attesa controfirme contratto da multiple parti via DocuSign webhook signal; pipeline ETL che attende ' +
      'batch downstream completed da sistema legacy mainframe che invia signal HTTP al termine; ' +
      "human-in-the-loop ML review dove il modello AI è incerto (confidence < soglia) e l'operatore deve " +
      'validare prima della propagazione downstream alla produzione.',
    configFields: [
      {
        key: 'signalName',
        label: 'Nome del segnale',
        type: 'text',
        required: true,
        placeholder: 'es. contract_signed, approval_received',
        help: 'Identificatore univoco. I caller esterni fanno POST a /api/v1/signals/<name> per risvegliare il workflow. Deve essere unico per tenant. Usa snake_case.',
      },
      {
        key: 'timeoutSeconds',
        label: 'Timeout (secondi)',
        type: 'number',
        required: false,
        defaultValue: '2592000',
        help: 'Tempo massimo di attesa. Dopo questo l\'engine prosegue con "defaultPayload". 0 = aspetta per sempre. 2592000 = 30 giorni (default). Calcoli rapidi: 3600=1h · 86400=1g · 604800=1sett.',
      },
      {
        key: 'defaultPayload',
        label: 'Payload di default (in caso di timeout)',
        type: 'code',
        language: 'json',
        required: false,
        defaultValue: '{"timeout": true}',
        help: 'JSON inviato ai nodi a valle quando scatta il timeout invece del segnale. Usa per distinguere "timeout" da "signal reale" (es. {"timeout": true}).',
      },
      {
        key: 'matchKey',
        label: 'Chiave di correlazione (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'es. order_id, ticket_id',
        help: 'Quando più workflow attendono lo stesso signal contemporaneamente, il body del signal deve contenere questa chiave col valore = expression sotto. Pattern "BPMN message correlation".',
      },
      {
        key: 'matchValue',
        label: 'Match value expression',
        type: 'expression',
        required: false,
        placeholder: 'input.order.id',
        help: 'Evaluated at pause time. Stored with the paused row; signal payload must match.',
      },
    ],
    outputContract: {
      notes: 'Mette in pausa l\'esecuzione. Questi campi sono quelli con cui il nodo si registra al momento della pausa; alla ripresa il flusso riparte dai nodi a valle.',
      fields: [
        { name: 'pausedOnSignal', type: 'string', desc: 'Il nome del segnale che il nodo sta aspettando.' },
        { name: 'timeoutSeconds', type: 'number', desc: 'Dopo quanti secondi rinuncia ad aspettare.' },
        { name: 'matchKey', type: 'string', desc: 'Il campo su cui riconoscere il segnale giusto fra piu` esecuzioni in attesa.' },
        { name: 'matchValue', type: 'string', desc: 'Il valore che quel campo deve avere.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
