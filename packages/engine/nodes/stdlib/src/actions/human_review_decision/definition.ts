/**
 * `flow_human_review_decision` — NodeDef.
 *
 * @module actions/human_review_decision/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const humanReviewDecisionNodeDef: NodeDef = {
  id: 'flow_human_review_decision',
  type: 'logic',
  label: 'Human Review: Decisione',
  icon: 'user-check',
  color: '#f59e0b',
  description:
    'Router di confidence enterprise che implementa il pattern Human-in-the-Loop per workflow AI-assisted ' +
    'production-ready. Confronta una metrica numerica di confidence (tipicamente 0.0 → 1.0) prodotta upstream da ' +
    'classifier LLM (agent_email_triage, agent_email_triage_commercialista, agent_summarizer), modelli computer ' +
    'vision (action_vision_extract), scraper AI (action_scrape_smart) o pipeline OCR, contro una soglia minima ' +
    'configurabile (default 0.70) abbinata a una lista di label "sensitive" che forzano comunque il branch review ' +
    'indipendentemente dalla confidence (es. label "legal_dispute", "fraud_suspected", "regulatory_complaint", ' +
    '"vip_customer", "executive_request" — categorie dove il rischio di errore costa più del ritardo umano). ' +
    'Emette uno dei due output branch del contratto: "auto" quando confidence ≥ soglia AND label non sensitive ' +
    '(il workflow prosegue senza intervento — bassa latenza, zero overhead operativo), "review" quando confidence ' +
    "< soglia OR label sensitive (il flusso si ferma e l'operatore umano riceve un task in coda con tutto il " +
    'contesto della decisione AI per validare, correggere o sovrascrivere). ' +
    "Audit reason esplicito nell'output: { branch, confidence, threshold, triggeringLabel?, autoApproved? }. " +
    'Pattern di composizione: la branch "review" si lega tipicamente a action_send_email / action_whatsapp_send / ' +
    "action_email_send_tracked per notificare l'operatore (con link al record da revisionare) + " +
    "logic_wait_signal per sospendere il run fino al callback umano (un'API HTTP segnata dal trigger_form della " +
    'dashboard tenant), poi resume con la decisione finale; il branch "auto" prosegue direttamente al downstream. ' +
    'Vantaggio vs implementazione manuale n8n/Zapier: 3-4 nodi (if + switch + set + log) incapsulati in un ' +
    "unico nodo dedicato con audit + GDPR-safe reason code + UI hint per l'operatore. " +
    'Use case: triage email cliente con confidence < 0.6 va a operatore (evita rispondere male a un cliente ' +
    'arrabbiato), classificazione fattura SDI con label "anomalia_iva" sempre revisionata da contabile, ' +
    'OCR fattura cartacea con confidence < 0.85 → human review per integrazione campi mancanti, sentiment analysis ' +
    'social con label "crisis_signal" sempre escalata al PR manager, decisione di erogazione bonus B2B sopra una ' +
    "soglia di importo sempre con review CFO indipendentemente dalla confidence dell'agent commerciale.",

  // Branch names — coerent col contratto di stdlib (pec_classify usa
  // 'received_message','acceptance_receipt',… come stringhe). Documentazione
  // delle 2 branch nel campo `description` qui sopra.
  outputs: ['auto', 'review'],
  // CRITICO: senza `branching:true` l'engine NON usa chosenBranch per
  // filtrare gli edge downstream (vedi workflow-engine.ts:270 nodeIsBranchable)
  // e propaga l'output a TUTTE le edges di entrambe le porte → fan-out
  // su `auto` + `review` contemporaneamente. Bug consulente 2026-06-05.
  branching: true,

  configFields: [
    {
      key: 'confidenceThreshold',
      label: 'Soglia confidence (0–1)',
      type: 'number',
      required: false,
      defaultValue: '0.7',
      help:
        'Sotto questo valore il branch è "review". Valori tipici: ' +
        '0.7 (default sicuro), 0.85 (conservativo: più review), 0.5 (aggressivo: più auto). ' +
        'Range [0,1].',
    },
    {
      key: 'confidenceField',
      label: 'Campo input con la confidence',
      type: 'text',
      required: false,
      defaultValue: 'confidence',
      help:
        "Percorso top-level del campo numerico (0–1) sull'input. " +
        'Default "confidence". Cambia se l\'upstream usa "score", "probability".',
    },
    {
      key: 'secondaryConfidenceField',
      label: 'Secondo campo confidence (opzionale)',
      type: 'text',
      required: false,
      placeholder: 'consistency_score',
      help:
        'Quando valorizzato, viene letta ANCHE la sua confidence. La ' +
        'decisione usa il MINIMO dei due → più conservativa. Util per ' +
        'classifier multi-segnale (es. classifier + consistency check).',
    },
    {
      key: 'alwaysReviewLabels',
      label: 'Label che forzano sempre review',
      type: 'text',
      required: false,
      placeholder: 'legal_request,fraud,payment_failed',
      help:
        'Lista comma-separated. Quando il classifier emette una di ' +
        'queste label, il branch è SEMPRE "review" anche se la confidence ' +
        'supera la soglia. Per categorie ad alto rischio dove un falso ' +
        'positivo costa di più (compliance, sicurezza, perdite economiche).',
    },
    {
      key: 'labelField',
      label: 'Campo input con la label',
      type: 'text',
      required: false,
      defaultValue: 'label',
      help: 'Default "label". Solo letto se alwaysReviewLabels è non-vuoto.',
    },
    {
      key: 'fallbackOnMissing',
      label: 'Review quando confidence / label mancano',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help:
        "Quando ON, se l'input non porta confidence numerica (o label " +
        'quando alwaysReviewLabels è valorizzato), il branch è "review" ' +
        '(safe-by-default). OFF = scegli "auto" su input incompleti — ' +
        "usa solo se sai che l'upstream è 100% affidabile.",
    },
    {
      key: 'reasonTemplate',
      label: 'Template reason code',
      type: 'text',
      required: false,
      placeholder: 'low_confidence_{label}',
      help:
        "Stringa stampata nell'output.reason per audit/UI operatrice. " +
        'Placeholder: {label} {confidence} {threshold}. ' +
        'Es: "low_confidence_{label}" → "low_confidence_legal_request".',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 1,
  },
};
