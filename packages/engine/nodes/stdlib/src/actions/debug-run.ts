/**
 * agent_debug_run_failure — analizza un run fallito e propone fix.
 *
 * Input: { runId, failedNodeId? } (failedNodeId opzionale: auto-detect dal run)
 * Output: {
 *   diagnosis: { rootCause, category, confidence },
 *   suggestedFixes: [{ type: 'config'|'retry'|'replace'|'guard', description, patch }],
 *   suggestedTests: [{ scenario, expectation, mockData }],
 *   replayCommand: { method, path, body } - one-click apply
 * }
 *
 * Pipeline:
 *  1. Fetch run JSON da runtime (steps + outputs + errors)
 *  2. Identifica failed step (status='error', first occurrence)
 *  3. Liara analyze con context: nodo config + input + error msg + downstream impact
 *  4. Pattern matching error → category (transient/config/payload/auth/quota)
 *  5. Genera fix proposals + test cases Zod validation
 *
 * Moat AI-native (vs n8n): non solo "ti dico cosa è fallito" ma "ti propongo
 * 3 fix valutati + test che provano che funzionano + one-click replay".
 */
import type { NodeModule } from '../types.js';

export const debugRunFailureNode: NodeModule = {
  def: {
    id: 'agent_debug_run_failure',
    type: 'action',
    label: 'AI Debug Run Failure',
    icon: 'bug',
    color: '#f87171',
    description:
      'Agente AI enterprise specializzato nel debug post-mortem di workflow run falliti — sfrutta il LLM Liara ' +
      'per analizzare i dati granular di una run errored (steps json + outputs + error stack + config dei ' +
      'nodi coinvolti) e produrre raccomandazioni actionable di fix con confidence score, riducendo il tempo ' +
      'mean-time-to-resolution da ore-giorni (debug manuale) a minuti (AI-assisted triage). Pattern di ' +
      'AIOps copilot per workflow orchestration analogo a Datadog Watchdog o New Relic AI per i monitoring ' +
      'tool tradizionali. ' +
      'Pipeline multi-stage gestita end-to-end dall\'agent: ' +
      '(1) Fetch run JSON completo dal SQLite runtime tenant — recupera tutti i steps eseguiti con il loro ' +
      'input/output, la error stack del step fallito, la config completa del nodo che ha generated l\'errore, ' +
      'il context delle env vars rilevanti; ' +
      '(2) Diagnose root cause via LLM analysis del context con 5 categorie di errore canoniche enterprise: ' +
      'transient (network blip, rate-limit 429 temporaneo, upstream 5xx — pattern auto-recoverable con retry), ' +
      'config (parametro mal-configurato, URL errato, schema mismatch — richiede edit dell\'utente), payload ' +
      '(input data malformato, type coercion failed, JSON parse error — issue upstream nei dati), auth ' +
      '(credenziali scadute, token revoked, scope insufficienti — richiede rotation/re-auth dell\'integration ' +
      'vault), quota (esauriti i limiti del piano o dell\'API upstream — richiede upgrade o ottimizzazione); ' +
      '(3) Genera 3-5 suggestedFixes ordinati per confidence + impact: config patch (modifica diff-friendly ' +
      'del config del nodo offendente), retry policy adjustment (aggiungi exponential backoff + max_retries=5 ' +
      'per transient), nodo replace (suggerimento di sostituire con un altro nodo più adatto al pattern), ' +
      'input guard (aggiungi logic_if upstream per validare il payload prima di processarlo); ' +
      '(4) Genera suggestedTests automaticamente Zod-validated — il LLM crea test case JSON che expose il ' +
      'bug specifico fixato, pattern TDD reverse per prevenire regressioni future. ' +
      'Output: { diagnosis: { rootCause (narrative description del cosa è andato storto), category (transient|' +
      'config|payload|auth|quota), confidence (0-1 dell\'AI sul suo verdetto) }, suggestedFixes: [{ ' +
      'description, type, configPatch?, confidence, expectedImpact }], suggestedTests: [{ input, expected, ' +
      'reason }], replayCommand (one-click apply del top fix + relaunch del workflow per validation) }. ' +
      'Use case: debugging assist post-incident enterprise (il workflow di chiusura conti mensile è fallito ' +
      'la notte → al risveglio l\'admin vede direttamente la diagnosi AI + fix proposto, applica con un click ' +
      'invece di indagare 2 ore); suggestions DX per junior workflow author che imparano gradualmente i ' +
      'pattern enterprise (AI come "rubber duck" intelligente); auto-recovery cron su workflow critici ' +
      '(workflow di production che ha catch error handler che chiama agent_debug + auto-apply del fix se ' +
      'confidence > 0.9); training dataset per fine-tune del Liara su pattern errori reali specifici del ' +
      'workspace customer per personalization (i Liara LoRA del cliente che imparano nel tempo cosa è "fine" ' +
      'vs "broken" nel suo contesto specifico).',
    configFields: [
      {
        key: 'runId',
        label: 'Run ID',
        type: 'expression',
        required: true,
        placeholder: '{{input.runId}} o "run_a1b2c3..."',
        help: 'ID del run da analizzare. Recuperabile da run history o trigger error_handler.',
      },
      {
        key: 'failedNodeId',
        label: 'Failed Node ID (opzionale)',
        type: 'expression',
        required: false,
        help: 'Se vuoto, auto-detect dal primo step con status=error. Specifica per analisi mirata su nodo non terminale.',
      },
      {
        key: 'includeTests',
        label: 'Genera test cases',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se on, l\'agente genera test scenarios + mock data + expected output per ogni fix proposto.',
      },
      {
        key: 'maxFixes',
        label: 'Numero max fix proposti',
        type: 'number',
        required: false,
        defaultValue: '3',
        help: 'Da 1 a 5. Più fix = più tempo LLM ma più alternative.',
      },
      {
        key: 'autoReplay',
        label: 'Replay automatico con fix top-1',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'PERICOLO: se on, applica il fix con confidence più alta e replaya il run automaticamente. Solo per workflow non-critici o con guard a valle.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
