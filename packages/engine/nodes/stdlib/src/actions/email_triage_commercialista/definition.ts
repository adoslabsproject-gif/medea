/**
 * `agent_email_triage_commercialista` — NodeDef.
 *
 * @module actions/email_triage_commercialista/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailTriageCommercialistaNodeDef: NodeDef = {
  id: 'agent_email_triage_commercialista',
  type: 'ai',
  label: 'AI Triage Commercialista IT',
  icon: 'sparkles',
  color: '#ec4899',
  description:
    'Classifier rule-based specializzato per studi commercialisti italiani, knowledge embedded del lessico ' +
    'tributario italiano 2025-2026 (riforma fiscale, regime forfettario adeguato, F24 nuovo modello, fatturazione ' +
    'elettronica SDI 1.2.1, certificazione unica, comunicazione liquidazioni IVA, esterometro). Tag con 9 ' +
    'categorie di dominio mutuamente esclusive: fiscale (questioni IRPEF, deduzioni, detrazioni, dichiarazione ' +
    'redditi 730/Modello Redditi), iva (liquidazioni periodiche, esterometro, autofattura, reverse charge, ' +
    'split payment), f24 (deleghe di pagamento, F24 elide, ravvedimento operoso, compensazioni), forfettario ' +
    '(regime forfettario L. 190/2014, soglie 85k, contributi INPS gestione separata, fattura elettronica ' +
    'obbligatoria), sollecito (clienti morosi, mancato pagamento parcella, contestazione importo), pec_legal ' +
    '(PEC contenenti notifiche legali, decreti ingiuntivi, ricorsi tributari, atti AdE/Equitalia), payment ' +
    '(comunicazioni dirette su bonifici ricevuti, conferma pagamento parcella, richiesta IBAN), bilancio ' +
    '(chiusura bilancio annuale, nota integrativa, deposito CCIAA, revisione, certificazione), altro ' +
    '(catch-all per email non-pertinenti al dominio fiscale). ' +
    'Output: { label, confidence (0-1 derivata dal numero e specificità delle keyword matched), matchedKeywords ' +
    '(array di termini italiani specifici trovati, utile per audit + debug), suggestedOperator (default mapping: ' +
    'fiscale→commercialista_senior, iva→specialista_iva, forfettario→junior, ecc., overridabile via ' +
    'operatorsJson), suggestedReplyTemplate (placeholder reply context-aware: "Buongiorno {{nome}}, abbiamo ' +
    "ricevuto la sua richiesta sull'argomento {{label}}. La presa in carico è confermata, le risponderemo entro " +
    '{{urgency_sla}} ore." con variabili pronte per nodemailer), urgencyTier (low/medium/high/critical derivato ' +
    'da signal "scadenza", "AdE", "termine", "ravvedimento", "ricorso") }. ' +
    'Pure function: nessun LLM call, nessuna chiamata di rete, deterministica con latenza < 5ms — eseguibile ' +
    'tranquillamente in pipeline real-time anche su 1000 email/giorno senza saturare il gateway LLM né incidere ' +
    'sui costi BYOK Anthropic/OpenAI del cliente. ' +
    "Pattern di composizione raccomandato: collegare l'output a flow_human_review_decision sulla confidence " +
    '(soglia 0.7) — basso confidence o label "altro" routing alla coda umana del titolare studio; sull\'altra ' +
    'branch auto-approved, agganciare action_email_send_tracked usando ' +
    '{{$node.triage.json.suggestedReplyTemplate}} come body e operatore assegnato da suggestedOperator. ' +
    'Use case: studio commercialista a Milano riceve 80 email/giorno — il triage automatizza 70% di smistamento ' +
    'verso il commercialista giusto senza interventi della segreteria; alerting su urgencyTier=critical per email ' +
    'da PEC AdE con "ricorso" o "ravvedimento" (notifica WhatsApp al titolare entro 5 minuti); riduzione costo ' +
    'risposta tipica da 12 minuti operatore a 2 minuti (read+conferma); arricchimento CRM Odoo con label come ' +
    'tag su crm.lead per analytics business; pre-step a un agent LLM più costoso quando confidence bassa.',

  configFields: [
    {
      key: 'subjectField',
      label: 'Campo input — subject',
      type: 'text',
      required: false,
      defaultValue: 'subject',
    },
    {
      key: 'bodyField',
      label: 'Campo input — body',
      type: 'text',
      required: false,
      defaultValue: 'body',
    },
    {
      key: 'fromField',
      label: 'Campo input — from',
      type: 'text',
      required: false,
      defaultValue: 'from',
    },

    {
      key: 'operatorsJson',
      label: 'Override operatori (JSON)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '{"fiscale":"anna@studio","f24":"marco@studio"}',
      help:
        'Mappa label→email operatrice. Le label non specificate ' +
        'usano il default. Default: fiscale@studio, iva@studio, ' +
        'pagamenti@studio (f24), titolare@studio (sollecito), ' +
        'archivio@studio (pec_legal), amministrazione@studio (payment), ' +
        'societario@studio (bilancio), segreteria@studio (altro).',
    },
    {
      key: 'replyTemplatesJson',
      label: 'Override template risposta (JSON)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '{"f24":"Riceverà l\'F24 entro 24h."}',
      help:
        'Mappa label→testo risposta. Default: skeleton IT polite per ' +
        'ogni categoria. Visualizzabile come body sendEmail downstream.',
    },
    {
      key: 'urgencyJson',
      label: 'Override urgency (JSON)',
      type: 'code',
      language: 'json',
      required: false,
      placeholder: '{"payment":"normal"}',
      help:
        'Valori: high / normal / low. Default high: sollecito + ' +
        'pec_legal + f24. Default low: payment + altro. ' +
        'normal: tutti gli altri.',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 4 },
};
