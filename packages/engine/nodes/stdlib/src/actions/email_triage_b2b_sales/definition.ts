/**
 * `agent_email_triage_b2b_sales` — NodeDef.
 *
 * @module actions/email_triage_b2b_sales/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailTriageB2BSalesNodeDef: NodeDef = {
  id: 'agent_email_triage_b2b_sales',
  type: 'action',
  label: 'AI: Triage risposte vendita B2B',
  icon: 'brain',
  color: '#8b5cf6',
  description:
    'Classificatore di risposte email B2B per cold-outreach commerciali (sales sequence automation) e ' +
    'campagne export multilingua. Quando un agente di vendita lancia una sequence outbound a 200 prospect, le ' +
    'risposte ricevute si concentrano in 8 archetipi prevedibili che richiedono azioni follow-up nettamente ' +
    'diverse — automatizzare la classificazione e la prossima azione liberare il SDR/AE dalle 4-6 ore/settimana ' +
    'di triage manuale e migliora il tempo di risposta (oggi: 8h medio → con questo nodo: 2 minuti). ' +
    'Le 8 categorie classificate sono: interested_buy (segnale di acquisto immediato: "quanto costa?", "manda ' +
    'preventivo", "siamo interessati a acquistare 50 unità"), interested_info (vuole più info ma non è ancora ' +
    'comprato: "manda catalogo", "cosa includete", "posso avere una demo"), interested_tasting (richiesta di ' +
    'prova/degustazione/sample — case food&beverage, software trial, sample fisico), not_interested ' +
    '("attualmente non ci serve", "abbiamo già un fornitore"), wrong_recipient ("non sono io il responsabile, ' +
    'rivolgiti a Maria di acquisti maria@..."), complaint (lamentela: "non scrivere più", "abbiamo segnalato la ' +
    'vostra azienda al Garante"), out_of_office (auto-reply OOO: "sono in ferie fino al 15/07, contatta x@..." — ' +
    'da gestire con scheduled re-send), spam (false positive ricevuti su email che NON era un prospect: ricevuti ' +
    'di consegna inattesi, response a marketing aziende generiche tipo "ho visto la vostra newsletter"). ' +
    'Multilingua native con rilevamento automatico via euristica letterale: italiano, inglese, tedesco, francese ' +
    '— spagnolo e portoghese supportati ma con confidence ridotta del 10% (corpus training minore). ' +
    'Output rich: { label, confidence (0-1), matchedKeywords (per audit del PERCHÉ è stata data quella label, ' +
    'utile in dispute con AE che contesta "ma era interessato!"), language, suggestedAction (mappa label → azione ' +
    'concreta del workflow: send_catalog, send_quote, book_tasting_calendar, archive_silent, ' +
    'forward_to_human_inbox, send_unsubscribe_confirm), replyDraft (bozza di risposta pre-tradotta nella stessa ' +
    'lingua del prospect, tono professionale + customizzabile con templating downstream) }. ' +
    'Confidence sotto la soglia (default 0.7) viene declassata a needs_human_review per evitare azioni ' +
    'automatiche imbarazzanti su email ambigue — l\'AE conferma manualmente la categoria, e il signal feedback ' +
    'può alimentare retraining della pipeline. ' +
    'Pattern di composizione: collegare l\'output a logic_switch sul campo label con 8+1 (review) branch — ogni ' +
    'branch ha una catena di azioni diversa (interested_buy → action_send_email con quote PDF + create lead in ' +
    'crm.lead Odoo; not_interested → archive + decrement engagement score; OOO → schedule re-send tra +14 giorni). ' +
    'Use case: azienda food italiana fa export Germania, riceve 80 risposte/giorno a campagna outreach buyer ' +
    'tedeschi e l\'agent classifica automaticamente; SaaS B2B europeo gestisce inbound demo request in 5 lingue ' +
    'senza traduzioni manuali; vinaio piccolo invia outreach a importatori UK e categoria interested_tasting ' +
    'attiva automaticamente la spedizione del kit assaggio con tracking corriere; consulenza enterprise riceve ' +
    'risposte VP/C-level e wrong_recipient instrada SDR al referente corretto entro 5 minuti.',
  configFields: [
    {
      key: 'subjectField',
      label: 'Campo subject',
      type: 'text',
      required: false,
      defaultValue: 'subject',
      help: 'Nome del campo nell\\\'input upstream che contiene il subject email. Default: `subject` (trigger IMAP).',
    },
    {
      key: 'bodyField',
      label: 'Campo body',
      type: 'text',
      required: false,
      defaultValue: 'body',
      help: 'Nome del campo nell\\\'input upstream che contiene il corpo email (plain text o HTML). Default: `body`.',
    },
    {
      key: 'fromField',
      label: 'Campo from (sender)',
      type: 'text',
      required: false,
      defaultValue: 'from',
      help: 'Nome del campo col mittente. Usato per il bypass noreply→out_of_office. Default: `from`.',
    },
    {
      key: 'lang',
      label: 'Lingua',
      type: 'select',
      required: false,
      options: ['auto', 'it', 'en', 'de', 'fr'],
      defaultValue: 'auto',
      help: '`auto` (default) rileva da stop-word italiani/inglesi/tedeschi/francesi. ' +
        'Forza una lingua quando hai un mercato specifico e vuoi consistenza.',
    },
    {
      key: 'minConfidence',
      label: 'Soglia confidence (0–1)',
      type: 'number',
      required: false,
      defaultValue: '0.7',
      help: 'Sotto questa soglia la label viene sostituita da `needs_human_review` e ' +
        '`suggestedAction = forward_to_human`. Alza per essere più conservativi (più review umane), ' +
        'abbassa per più automazione (più rischio di errori).',
    },
  ],
  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 5 },
};
