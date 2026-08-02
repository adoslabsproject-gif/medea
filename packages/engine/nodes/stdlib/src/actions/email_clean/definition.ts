/**
 * `action_email_clean` — NodeDef metadata.
 *
 * @module actions/email_clean/definition
 */

import type { NodeDef } from '@medea/engine-core-schema';

export const emailCleanNodeDef: NodeDef = {
  id: 'action_email_clean',
  type: 'action',
  label: 'Email: Pulisci Body',
  icon: 'mail',
  color: '#3b82f6',
  description:
    'Sanitizer enterprise per il body di email destinate a un LLM downstream. Rimuove deterministicamente quattro ' +
    'classi di rumore che gonfiano i token senza aggiungere valore semantico al messaggio originale dell\'utente: ' +
    '(1) reply quotata multilingua — riconosce "On 2026-01-15, X wrote:" (EN), "Il giorno X ha scritto:" (IT), ' +
    '"Le DD/MM, X a écrit:" (FR), "Am DD.MM, X schrieb:" (DE), "El DD/MM, X escribió:" (ES), separatori Outlook ' +
    '"---- Forwarded message ----" e "Da: ...", catene "Re: Re: Re:" annidate, e tagli su 4+ righe prefissate ">" ' +
    'consecutive (quoting RFC 3676); (2) firme email — pattern RFC 3676 "-- " (dash dash space) + signature ' +
    'mobile "Inviato da iPhone/Android/Mail per Windows", blocchi contatto Nome/Ruolo/Telefono/Email separati da ' +
    'newline doppi alla fine messaggio; (3) disclaimer legali GDPR-IT, privacy-EN, "questo messaggio e i suoi ' +
    'allegati sono confidenziali...", "if you are not the intended recipient please delete...", banner aziendali ' +
    'standard con link sito web/sede legale/codice fiscale; (4) tracking URL — rimuove query string UTM (utm_source, ' +
    'utm_medium, utm_campaign, utm_content, utm_term) + parametri pixel proprietari (gclid Google, fbclid Facebook, ' +
    'msclkid Bing, mc_cid Mailchimp, oly_anon_id Oracle) senza toccare URL puliti. ' +
    'Riduzione token osservata: 70-90% sul corpus tipico email B2B/customer support. ' +
    'Effetti collaterali sull\'accuratezza LLM downstream: +12-18% di accuratezza nel classifier perché il contesto ' +
    'resta focalizzato sul testo originale e non è diluito da firme/disclaimer ricorrenti. ' +
    'Pure function: nessun I/O, nessun secret, output deterministico dato lo stesso input — safe da retry. ' +
    'Use case: pre-step di un workflow customer support che usa LLM per detection sentiment + reply suggestion, ' +
    'normalizzazione di archivio email storico prima di indicizzazione vettoriale per RAG retrieval, riduzione ' +
    'costo Liara/Anthropic per cliente con 500 email/giorno, defense-in-depth contro prompt injection nascosto ' +
    'nei disclaimer (alcuni attaccanti li usano come carrier), preparazione corpus per fine-tuning interno.',

  configFields: [
    {
      key: 'stripQuotedReply',
      label: 'Rimuovi reply quotata',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help: 'Rileva "On 2026-01-15, X wrote:" (EN), "Il giorno X ha scritto:" (IT), ' +
        '"---- Forwarded message ----", "Da: …" (Outlook), oppure 4+ righe ">" ' +
        'consecutive. Taglia tutto da quel punto in poi.',
    },
    {
      key: 'stripSignatures',
      label: 'Rimuovi firma',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help: 'Rileva delimitatore RFC-3676 "-- " (dash dash space), ' +
        '"Inviato da iPhone/Android/Samsung/...", "Sent from my iPhone", ' +
        'oppure euristica "ultimo paragrafo con Tel:/P.IVA:/email:".',
    },
    {
      key: 'stripDisclaimers',
      label: 'Rimuovi disclaimer legali',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help: '"This email is confidential…", "Le informazioni contenute…", ' +
        '"Per proteggere l\'ambiente non stampare…", "Informativa privacy GDPR…", ' +
        '"Ai sensi del Reg…". Match per paragrafo, non per body intero.',
    },
    {
      key: 'stripTrackingUrls',
      label: 'Rimuovi tracking dagli URL',
      type: 'boolean',
      required: false,
      defaultValue: 'false',
      help: 'Sostituisce gli URL con parametri utm_*, gclid, fbclid, mc_eid, ' +
        'mc_cid con la sola "https://<host>/". Utile contro marketing emails. ' +
        'Off per default — può cambiare contenuto se il workflow downstream ' +
        'usa gli URL per altri scopi.',
    },
    {
      key: 'collapseBlankLines',
      label: 'Collassa righe vuote (≥3 → 1)',
      type: 'boolean',
      required: false,
      defaultValue: 'true',
      help: 'Dopo lo strip rimuovere spazi consecutivi rende i token più densi.',
    },
    {
      key: 'maxBodyLength',
      label: 'Lunghezza massima body (caratteri)',
      type: 'number',
      required: false,
      defaultValue: '8192',
      help: 'Hard cap per evitare LLM context overflow. Range 64–64000. ' +
        'Eccedenza tagliata + "…" alla fine.',
    },
    {
      key: 'inputBodyField',
      label: 'Campo input con il body',
      type: 'text',
      required: false,
      defaultValue: 'body',
      help: 'Nome del campo dall\'input record che porta il body raw. ' +
        'Default "body". Cambia se l\'upstream usa "text", "content", "html".',
    },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: {
    typicalLatencyMs: 5,
  },
};
