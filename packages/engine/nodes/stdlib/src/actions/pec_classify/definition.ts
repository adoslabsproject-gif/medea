/**
 * `action_pec_classify` — NodeDef metadata (branching: 4 outputs).
 *
 * @module actions/pec_classify/definition
 */

import type { NodeDef } from '@flowforge/core-schema';

export const pecClassifyNodeDef: NodeDef = {
  id: 'action_pec_classify',
  type: 'action',
  label: 'PEC: Classify',
  icon: 'route',
  color: '#0073e6',
  description:
    'Classificatore PEC (Posta Elettronica Certificata) conforme allo standard italiano AgID DPCM 02/11/2005 + ' +
    'Linee guida 2024. Ispeziona gli header tecnici della busta MIME (X-Ricevuta, X-Riferimento-Message-ID, ' +
    'X-TipoRicevuta, X-Trasporto, X-Mittente) e instrada il workflow su una sola delle 4 branch uscenti: ' +
    'received_message (PEC ordinaria in ingresso da un altro mittente certificato — va processata e archiviata ' +
    'per legge), acceptance_receipt (ricevuta di accettazione dal gestore mittente che conferma la presa in ' +
    'carico, valore legale come timbro postale), delivery_receipt (ricevuta di consegna dal gestore destinatario ' +
    'che attesta il deposito nella casella ricevente, equivalente alla raccomandata A/R), rejection (avviso di ' +
    'mancata consegna, mailbox piena, dominio non PEC, virus — tracciabile per riprovare o escalation). ' +
    'Pattern branching: l\'engine FlowForge segue SOLO l\'edge della branch scelta (chosenBranch), evitando ' +
    'fan-out errato sulle altre 3 branch downstream. Vincolo: usare SUBITO dopo trigger_imap_pec come primo step ' +
    'dispatcher — l\'ordine errato porterebbe a classificare email non-PEC con header generici (falso positivo). ' +
    'Output: { branch, headersParsed, messageRef, originalMessageId, transportInfo, gestoreCertificato }. ' +
    'Use case: studio commercialista riceve 200 PEC/giorno — separare le ricevute (archivio passive) dai veri ' +
    'messaggi cliente (workflow di lavorazione), conformità Codice CAD art. 48 per evidenza legale invio fattura, ' +
    'dashboard amministrativo che mostra solo "PEC inevase" filtrando ricevute automatiche, riconciliazione PEC ' +
    'in uscita (find acceptance + delivery matching tramite X-Riferimento-Message-ID), alerting su rejection ' +
    'che ferma uno scadenziario fiscale (es. consegna fattura SDI scaduta).',

  // Branching: the engine reads `result.branch` and follows the matching edge.
  outputs: ['received_message', 'acceptance_receipt', 'delivery_receipt', 'rejection'],
  // CRITICO: senza `branching:true` l'engine NON filtra gli edge downstream
  // tramite chosenBranch (vedi workflow-engine.ts:270 nodeIsBranchable) →
  // fan-out su TUTTE e 4 le branch invece di seguire solo quella scelta.
  branching: true,

  configFields: [
    {
      key: 'headersPath',
      label: 'Path agli headers nell\'input',
      type: 'text',
      required: false,
      defaultValue: 'headers',
      placeholder: 'headers    oppure    output.headers    oppure    mail.headers',
      help: 'Percorso "dotted" dentro l\'input che punta all\'oggetto headers email. ' +
        'Default headers (matcha il trigger IMAP standard). ' +
        'Se l\'input arriva da un sub-workflow puo` servire output.headers.',
    },
    {
      key: 'includeHeadersInOutput',
      label: 'Includi headers X-* nell\'output',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
      help: 'Se on, l\'output del nodo include una copia dei soli header X-* (PEC ' +
        'metadata). Utile per audit. NON include From/Subject/To.',
    },
    {
      key: 'includePipelineLog',
      label: 'Includi log nell\'output',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 1,
  },
};
