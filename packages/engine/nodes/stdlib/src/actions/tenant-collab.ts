import type { NodeModule } from '../types.js';

/**
 * NodeDef per `action_tenant_collab` — collaborazione CROSS-TENANT via webhook
 * bridge HTTP. SOLO metadata UI: l'implementazione vive nell'executor
 * server-only `tenantCollabExecutor` (apps/flowforge-runtime/src/executors/
 * tenant-collab.ts), che firma HMAC, applica l'allowlist SSRF e scrive
 * l'audit GDPR del data-transfer.
 *
 * NOMI CAMPI: devono matchare ESATTAMENTE i `config.X` letti dall'executor
 * (contract test in tenant-collab.contract.test.ts lo pinna).
 */
export const tenantCollabNode: NodeModule = {
  def: {
    id: 'action_tenant_collab',
    type: 'action',
    label: 'Collaborazione: Invia a tenant',
    vendor: 'flowforge',
    version: '1.0.0',
    icon: 'share-2',
    color: '#0ea5e9',
    description:
      'Collaborazione CROSS-TENANT: invia dati a un workspace FlowForge di un ALTRO tenant in modo sicuro, ' +
      'tracciato e idempotente — il ponte ufficiale per far cooperare due aziende che usano FlowForge senza ' +
      'condividere database o credenziali (ogni tenant resta nel proprio container isolato, GDPR by design). ' +
      'Funziona come contratto API tra workflow: il tenant DESTINATARIO espone un trigger Webhook nel suo ' +
      'workflow e ti consegna URL di collaborazione + token di connessione (il token È il consenso: senza, ' +
      'nessun invio è verificabile; se lo ruota, la collaborazione si interrompe). Questo nodo invia il payload ' +
      'JSON a quell\'URL con firma HMAC-SHA256 (header x-ff-collab-signature su "timestamp.body", anti-replay ' +
      '±5 minuti) che il destinatario verifica impostando sul suo trigger Webhook: authMode "hmac-signature", ' +
      'hmacSecret = token condiviso, hmacHeader "x-ff-collab-signature", hmacTimestampHeader ' +
      '"x-ff-collab-timestamp". Sicurezza enterprise: gli URL ammessi sono SOLO webhook FlowForge ' +
      '(*.app.automazionezeli.com/api/v1/webhooks/…) — questo nodo NON è un HTTP generico e non può colpire ' +
      'altri host o API interne; la firma è calcolata UNA volta e riusata sui retry, così il destinatario non ' +
      'processa mai due volte lo stesso invio (at-most-once). Affidabilità: retry automatici con backoff ' +
      'esponenziale sui soli errori transitori (5xx/rete, mai sui 4xx), timeout configurabile, Idempotency-Key ' +
      'e correlation-id propagati negli header per la deduplica lato ricevente. Compliance: OGNI invio è un ' +
      'data-transfer cross-tenant registrato nell\'audit log immutabile (hash-chain) con destinatario, ' +
      'correlation-id e impronta sha256 del payload — MAI il contenuto (data minimization art. 5 GDPR). ' +
      'Output: { delivered, status, response, correlationId, idempotencyKey, attempts, signed, targetHost, ' +
      'durationMs }. Use case: il fornitore notifica al cliente la spedizione (ordine → webhook del cliente ' +
      'che aggiorna il suo gestionale); una capofila raccoglie i KPI giornalieri dalle controllate; uno studio ' +
      'commercialista riceve le fatture dai clienti; due partner si scambiano lead qualificati; supply-chain: ' +
      'l\'esaurimento scorte del rivenditore avvia il riordino sul workflow del produttore.',
    configFields: [
      {
        key: 'collaborationUrl',
        label: 'URL di collaborazione',
        type: 'text',
        required: true,
        placeholder: 'https://acme.app.automazionezeli.com/api/v1/webhooks/<workflowId>/<token>',
        pattern: '^https://[a-z0-9][a-z0-9-]*\\.app\\.automazionezeli\\.com/api/v1/webhooks/.+',
        patternMessage:
          'Deve essere un URL webhook FlowForge: https://<slug>.app.automazionezeli.com/api/v1/webhooks/…',
        help:
          'L\'URL del trigger Webhook del tenant destinatario (te lo fornisce lui, dal suo editor → nodo ' +
          'Webhook → "URL webhook"). Sono ammessi SOLO webhook FlowForge — altri host vengono rifiutati.',
      },
      {
        key: 'connectionToken',
        label: 'Token di connessione',
        type: 'secret',
        required: false,
        help:
          'Segreto concordato col destinatario: firma ogni invio (HMAC-SHA256) ed è il suo CONSENSO alla ' +
          'collaborazione. Il destinatario lo imposta come hmacSecret sul suo trigger Webhook ' +
          '(authMode "hmac-signature"). Obbligatorio se "Firma il payload" è attivo.',
      },
      {
        key: 'payloadJson',
        label: 'Payload (JSON)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.db_query_1.json}}',
        help:
          'Il JSON da inviare al tenant destinatario. Vuoto = inoltra l\'input del nodo. Supporta ' +
          '{{espressioni}}. Massimo 1 MB — per i file usa un link, non il contenuto.',
      },
      {
        key: 'signPayload',
        label: 'Firma il payload (HMAC)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'Consigliato SEMPRE attivo: il destinatario può verificare integrità e provenienza, con protezione ' +
          'anti-replay. Disattivalo solo se il suo webhook non usa authMode "hmac-signature".',
      },
      {
        key: 'waitForResponse',
        label: 'Attendi la risposta',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'Attivo: l\'output include la risposta del destinatario (utile se il suo workflow risponde con ' +
          'Webhook: Respond). Disattivo: fire-and-forget — conta solo la consegna (status 2xx).',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '15000',
        help: 'Tempo massimo per ogni tentativo di invio (1000–120000 ms). Default 15 secondi.',
      },
      {
        key: 'maxRetries',
        label: 'Retry massimi',
        type: 'number',
        required: false,
        defaultValue: '3',
        help:
          'Ritenta con backoff esponenziale SOLO su errori transitori (5xx, rete). 0–5. La firma resta la ' +
          'stessa su ogni retry: il destinatario non processa mai un invio due volte.',
      },
      {
        key: 'idempotencyKey',
        label: 'Idempotency key (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.trigger.json.orderId}}',
        help:
          'Chiave di deduplica propagata nell\'header Idempotency-Key. Vuota = generata automaticamente ' +
          'da run + nodo (stabile sui retry). Usa un ID di business (es. numero ordine) se il destinatario ' +
          'deve dedupare tra run diverse.',
      },
    ],
    outputs: [
      'delivered',
      'status',
      'response',
      'correlationId',
      'idempotencyKey',
      'attempts',
      'signed',
      'targetHost',
      'durationMs',
    ],
  },
};
