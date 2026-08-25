/**
 * `action_email_triage` — NodeDef metadata.
 *
 * @module actions/email_triage/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailTriageNodeDef: NodeDef = {
  id: 'action_email_triage',
  type: 'action',
  label: 'Email Triage',
  icon: 'mail-search',
  color: '#22c55e',
  description:
    'Normalizzatore email pre-LLM enterprise: trasforma un oggetto RawEmail (subject, body, headers, attachments) ' +
    'in un payload denso e token-efficient pronto per un classifier downstream a base di prompting o agent LLM. ' +
    'Estrae mittente normalizzato (lowercase, validazione RFC 5321), dominio del sender per matching domain ' +
    'allowlist/blocklist enterprise, soggetto pulito da prefissi noise tipo "Re:", "Fwd:", "AW:", "Tr:", "R:", ' +
    '"Risp:" (multilingua) e suffix marketing "[Newsletter]". Tronca il body a una soglia configurabile (default ' +
    "4000 char) preservando la prima parte del messaggio dove l'umano ha più probabilmente messo la richiesta " +
    'chiave. Riassume gli allegati raggruppandoli per MIME type (3 PDF, 1 XLSX, 2 immagini) invece di passare ' +
    'metadati granulari. Indovina la lingua via euristica fast (it/en/es/fr/de) sulla porzione di testo. ' +
    'Calcola signals euristici: urgenza (parole come "urgente", "scadenza", "ASAP", presenza di "!!" multiple), ' +
    "PEC (dominio nell'allowlist provider certificati + header X-Riferimento), newsletter (List-Unsubscribe " +
    'header, mittente noreply@, footer "se non vuoi più ricevere"). ' +
    'Output: { senderEmail, senderDomain, subjectClean, bodyTextShort, attachments, languageGuess, ' +
    'urgencySignals, isPec, isNewsletter, messageId, headers }. ' +
    'Riduzione token osservata: 70-90% rispetto al passare la RawEmail al LLM. ' +
    'Use case: pre-step di un agent LLM di classificazione per studio commercialista (riduce costo Liara per ' +
    'email cliente da 800 a 80 token in input), filtro newsletter prima di un flow human-review (skip se ' +
    'isNewsletter=true), routing dinamico via switch per PEC vs ordinaria, alerting su signal urgency per ' +
    'inoltro al titolare studio, pre-validazione dominio mittente contro blocklist anti-phishing.',

  configFields: [
    {
      key: 'inputPath',
      label: "Path all'email nell'input",
      type: 'text',
      required: false,
      defaultValue: '',
      placeholder: 'output    oppure    mail    (vuoto = input diretto)',
      help:
        "Percorso dotted dentro l'input. Vuoto = l'input stesso e` l'oggetto email " +
        '(formato RawEmail). Per pipeline annidate puo` servire output o mail.',
    },
    {
      key: 'bodyMaxChars',
      label: 'Max caratteri body',
      type: 'number',
      required: false,
      defaultValue: '2000',
      help:
        'Lunghezza max di bodyTextShort. Range 200-20000. Default 2000 — buon compromesso ' +
        'tra contesto LLM e cost. Per email lunghissime (allegato annotazione) alza a 5000.',
    },
    {
      key: 'includePipelineLog',
      label: "Includi log nell'output",
      type: 'boolean',
      required: false,
      defaultValue: 'true',
    },
  ],

  outputContract: {
    notes: 'Nessun LLM: legge e normalizza il messaggio con regole, quindi lo stesso messaggio da` sempre lo stesso esito. Il corpo esce ACCORCIATO in `bodyTextShort`; la lunghezza vera e` in `bodyTextOriginalLength`, e se i due numeri non coincidono il testo e` tagliato.',
    fields: [
      { name: 'senderName', type: 'string', desc: 'Il nome del mittente, separato dall\'indirizzo.' },
      { name: 'senderEmail', type: 'string', desc: 'Il solo indirizzo del mittente, senza il nome.' },
      { name: 'senderDomain', type: 'string', desc: 'Il dominio del mittente: comodo per raggruppare o filtrare.' },
      { name: 'subjectClean', type: 'string', desc: 'L\'oggetto senza i prefissi di risposta e inoltro.' },
      { name: 'bodyTextShort', type: 'string', desc: 'Il corpo testuale accorciato al limite scelto.' },
      { name: 'bodyTextOriginalLength', type: 'number', desc: 'Quanto era lungo davvero il corpo.' },
      { name: 'attachments', type: 'object', desc: 'Il quadro degli allegati: quanti sono e che tipo.' },
      { name: 'languageGuess', type: 'string', desc: 'La lingua riconosciuta nel messaggio.' },
      { name: 'urgencySignals', type: 'array', desc: 'Le espressioni di urgenza trovate nel testo.' },
      { name: 'isPec', type: 'boolean', desc: 'Se il messaggio arriva da una casella certificata.' },
      { name: 'isNewsletter', type: 'boolean', desc: 'Se sembra una newsletter e non una email personale.' },
      { name: 'messageId', type: 'string', desc: 'Il Message-ID, per correlare le risposte.' },
      { name: 'pipelineSteps', type: 'array', desc: 'Il diario del passaggio. Presente solo col registro acceso.' },
    ],
  },
  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 2,
  },
};
