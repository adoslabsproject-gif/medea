import type { NodeModule } from '../types.js';

/**
 * GAP 5 — trigger_error: entry-point dei workflow ERROR-HANDLER.
 *
 * Supera l'Error Trigger di n8n: il binding non è solo per-workflow
 * (workflows.error_workflow_id, E4) ma anche CATCH-ALL a livello tenant
 * (system_flags error_workflow_id) — un solo handler per tutta l'automazione
 * senza doverlo agganciare workflow per workflow. Anti-loop garantito dal
 * runtime (un error-handler che fallisce non triggera se stesso né altri
 * handler, triggerType='error-handler') + rate-cap WE-14 (max 60/min).
 */
export const errorTriggerNode: NodeModule = {
  def: {
    id: 'trigger_error',
    type: 'trigger',
    label: 'Error Handler',
    icon: 'alert-triangle',
    color: '#ef4444',
    description:
      "Innesco automatico quando UN ALTRO workflow del tenant fallisce — l'entry-point dei workflow di " +
      "error-handling enterprise (equivalente potenziato dell'Error Trigger di n8n). Due livelli di binding: " +
      '(1) per-workflow, impostando "Error workflow" nelle impostazioni del workflow sorvegliato; (2) CATCH-ALL ' +
      'di tenant via impostazione dedicata — ogni run fallito senza handler proprio arriva qui, senza dover ' +
      "agganciare l'handler workflow per workflow. Il payload in ingresso è STRUTTURATO e stabile: " +
      '{ sourceWorkflowId, sourceWorkflowName, runId, status, errorCount, failedSteps: [{nodeId, error, ' +
      'errorCode?}], startedAt, endedAt } — pronto per logic_if di routing per gravità, agent_summarizer per ' +
      'la spiegazione AI, email_send/whatsapp_send per la notifica on-call, db_insert per il registro incident. ' +
      'Protezioni runtime integrate: anti-loop (un error-handler che fallisce NON triggera altri handler — ' +
      'triggerType=error-handler), anti-self (un workflow non può essere handler di se stesso), rate-cap ' +
      '60 fan-out/minuto per workflow sorgente (WE-14, anti tempesta da workflow che fallisce in loop). ' +
      "Ogni run fallito è inoltre registrato come evento STRUTTURATO nell'audit log immutabile del tenant " +
      '(hash-chain) — la scatola nera resta anche se runs viene archiviato. ' +
      'Use case: notifica Slack/email al team quando una pipeline di fatturazione fallisce, con i dettagli del ' +
      'nodo rotto; registro incident su tabella DB con conteggio errori per workflow (dashboard SLA cliente); ' +
      'retry intelligente — logic_if su errorCode (rate_limit → logic_delay 5min + re-invoke via ' +
      'action_http; auth → notifica "rinnova credenziali"); triage AI — agent_summarizer riassume il guasto in ' +
      'italiano comprensibile e propone il fix al non-tecnico; escalation a 2 livelli (prima email, poi ' +
      "WhatsApp se lo stesso workflow fallisce 3 volte in un'ora usando db_query sul registro).",
    configFields: [
      {
        key: 'aiTriage',
        label: 'Triage AI (Liara)',
        type: 'select',
        required: false,
        options: ['false', 'true'],
        defaultValue: 'false',
        help:
          'Se attivo, il payload in ingresso include `aiTriage` con la diagnosi AI del run fallito ' +
          "(explanation, fix, rootCause, risk, confidence) generata PRIMA del lancio dell'handler — " +
          'pronta per email/notifiche senza altri nodi AI. Fail-soft: se la diagnosi fallisce o tarda, ' +
          "l'handler parte comunque senza. Default spento: zero costo LLM se non richiesto.",
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
