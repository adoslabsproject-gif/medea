import type { NodeModule } from '@flowforge/nodes-stdlib';

/**
 * Aruba PEC connector.
 *
 * Aruba PEC è una normale casella SMTP standard sotto il cofano: la "P" (di
 * Posta Elettronica Certificata) viene aggiunta dal gateway Aruba che firma
 * il messaggio e produce la "ricevuta di consegna". Quindi inviamo via SMTP
 * standard (smtps.pec.aruba.it:465 TLS) tramite nodemailer — gli allegati
 * passano come MIME multipart, supporto nativo.
 *
 * Il path SOAP WSSE legacy è mantenuto per workflow precedenti, ma non
 * supporta allegati (la WSDL non è documentata pubblicamente per quello).
 */
export const pecArubaSend: NodeModule = {
  def: {
    id: 'italia_pec_aruba_send',
    type: 'action',
    label: 'PEC: Send (Aruba)',
    icon: 'mail',
    color: '#0073e6',
    description: 'Invia un messaggio PEC tramite casella Aruba. Default: SMTP standard (smtps.pec.aruba.it:465) con supporto allegati. Modalità SOAP legacy disponibile per workflow esistenti.',
    configFields: [
      {
        key: 'transport',
        label: 'Modalità di invio',
        type: 'select',
        required: false,
        options: ['smtp', 'soap'],
        defaultValue: 'smtp',
        help: 'smtp = standard SMTP via nodemailer, supporta allegati (raccomandato). soap = legacy SOAP WSSE Aruba, NIENTE ALLEGATI.',
      },
      { key: 'username', label: 'PEC username', type: 'text', required: true, placeholder: 'mio.account@pec.it', help: 'Email PEC completa (es. nome.cognome@pec.it).' },
      { key: 'password', label: 'PEC password', type: 'secret', required: true },
      { key: 'to', label: 'Destinatario PEC', type: 'expression', required: true, placeholder: 'destinatario@pec.it', help: 'Una PEC per riga, separate da virgola. Supporta {{espressioni}}.' },
      { key: 'subject', label: 'Oggetto', type: 'expression', required: true, placeholder: 'Comunicazione importante {{$today}}' },
      { key: 'body', label: 'Corpo (plain text)', type: 'expression', required: true, help: 'Testo del messaggio. PEC preferisce plain text per conservazione legale.' },
      {
        key: 'attachmentsJson',
        label: 'Allegati',
        type: 'attachments',
        required: false,
        help: 'Carica file dal computer (base64) o linka via URL/path server. Solo modalità SMTP — in modalità SOAP gli allegati vengono ignorati.',
        showIf: { field: 'transport', equals: 'smtp' },
      },
      {
        key: 'smtpHost',
        label: 'Host SMTP (override)',
        type: 'text',
        required: false,
        placeholder: 'smtps.pec.aruba.it',
        help: 'Vuoto = default smtps.pec.aruba.it. Cambia solo per setup non-standard.',
        showIf: { field: 'transport', equals: 'smtp' },
      },
      {
        key: 'smtpPort',
        label: 'Porta SMTP',
        type: 'number',
        required: false,
        defaultValue: '465',
        help: '465 = TLS implicit (default). 587 = STARTTLS upgrade. 25 = plain (sconsigliato).',
        showIf: { field: 'transport', equals: 'smtp' },
      },
      {
        key: 'smtpSecurity',
        label: 'Cifratura SMTP',
        type: 'select',
        required: false,
        options: ['tls', 'starttls', 'plain'],
        defaultValue: 'tls',
        help: 'tls = porta 465 (raccomandato Aruba). starttls = porta 587. plain = porta 25, NESSUNA cifratura (mai in produzione).',
        showIf: { field: 'transport', equals: 'smtp' },
      },
      {
        key: 'endpoint',
        label: 'Endpoint SOAP (modalità soap)',
        type: 'text',
        required: false,
        placeholder: 'https://ws.pec.aruba.it/PecManagement/services/PecService',
        help: 'URL endpoint del web service Aruba PEC. Vuoto = default. Solo per modalità SOAP legacy.',
        showIf: { field: 'transport', equals: 'soap' },
      },
    ],
    vendor: 'flowforge-italia',
    version: '0.4.0',
  },
};

export const pecArubaReceive: NodeModule = {
  def: {
    id: 'italia_pec_aruba_receive',
    type: 'trigger',
    label: 'PEC: Receive (Aruba)',
    icon: 'inbox',
    color: '#22c55e',
    description:
      'Esegue il workflow alla ricezione di una nuova PEC su account Aruba (polling IMAP imaps.pec.aruba.it:993 SSL). ' +
      'Filtro opzionale per oggetto (regex). Per la classificazione del contenuto usa action_pec_classify downstream. ' +
      'Input al workflow per messaggio: { messageId, from, to, subject, body, attachments[] (filename, contentType, size, contentBase64), ' +
      'pecHeaders (X-Trasporto/X-Ricevuta/X-Riferimento-Message-ID), pecType }. pecType è derivato dagli header PEC normati (DPR 68/2005): ' +
      'received (busta di trasporto = PEC vera), acceptance (accettazione), delivery (avvenuta-consegna), reject (non-accettazione/errore/mancata-consegna/virus). ' +
      'Use case: archivio legale automatico PEC ricevute, triage studio commercialista (parse fatture/cartelle/notifiche), ' +
      'forward selettivo PEC clienti su CRM, audit trail compliance art. 2710 c.c.',
    configFields: [
      { key: 'username', label: 'PEC username', type: 'text', required: true, placeholder: 'mio.account@pec.it' },
      { key: 'password', label: 'PEC password', type: 'secret', required: true },
      { key: 'pollIntervalSec', label: 'Intervallo polling (secondi)', type: 'number', required: false, defaultValue: '60', help: 'Frequenza con cui controllare nuove PEC. Default 60s.' },
      {
        key: 'filterSubject',
        label: 'Filtro oggetto (regex, opzionale)',
        type: 'text',
        required: false,
        placeholder: '^(Fattura|Sollecito)',
        help: 'Esegue il workflow solo se l\'oggetto matcha questa regex. Esempi: ^Fattura.* · \\[URGENTE\\] · .*scadenza.*',
      },
      // Parametri di connessione IMAP letti dall'executor (pec-receive.ts):
      // erano supportati (con default Aruba) ma NON esposti → l'utente non poteva
      // tunarli. Aggiunti (default = Aruba PEC) — contract test li garantisce.
      {
        key: 'mailbox', label: 'Cartella IMAP', type: 'text', required: false, defaultValue: 'INBOX',
        help: 'Cartella da cui leggere le PEC. Default INBOX.',
      },
      {
        key: 'maxMessages', label: 'Max messaggi per poll', type: 'number', required: false, defaultValue: '50',
        help: 'Quante PEC non lette processare al massimo per ciclo. Default 50.',
      },
      {
        key: 'host', label: 'Host IMAP (avanzato)', type: 'text', required: false, placeholder: 'imaps.pec.aruba.it',
        help: 'Override del server IMAP. Default Aruba (imaps.pec.aruba.it). Cambialo solo per altri provider PEC.',
      },
      {
        key: 'port', label: 'Porta IMAP (avanzato)', type: 'number', required: false, defaultValue: '993',
        help: 'Porta IMAPS. Default 993. Cambiala solo per provider non-standard.',
      },
    ],
    vendor: 'flowforge-italia',
    version: '0.4.0',
  },
};
