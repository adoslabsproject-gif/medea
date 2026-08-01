import type { NodeModule } from '../types.js';

/**
 * action_webhook_respond — synchronous response for a webhook trigger.
 *
 * Mirrors n8n's "Respond to Webhook" node but adds:
 *   • Explicit respondWith mode (json / text / html / redirect / binary / empty / custom)
 *   • Status code presets with human-readable meanings
 *   • Auto-routing of Content-Type from respondWith (no manual sync needed)
 *
 * Pattern:
 *   [Webhook trigger]  →  ... pipeline ...  →  [Webhook Respond]
 *        receives                                  sends back to
 *        HTTP request                              the original caller
 *
 * The runtime uses this by scanning every step output after the run finishes.
 * If it finds a `__webhookResponse` sentinel, that payload shapes the HTTP
 * reply (status + content-type + body bytes + extra headers) instead of the
 * default `{runId, status}` JSON envelope.
 */
export const webhookRespondNode: NodeModule = {
  def: {
    id: 'action_webhook_respond',
    type: 'action',
    label: 'Webhook: Respond',
    icon: 'link',
    color: '#22c55e',
    description:
      'Risponde alla richiesta HTTP del trigger_webhook con body, status code e headers personalizzati. Da posizionare ALLA FINE del ramo workflow quando il chiamante aspetta una response sincrona — senza questo nodo (e con responseMode="use-respond-node" nel trigger) il runtime restituisce JSON fallback `{runId, status}`, non quello che vuole il vendor partner B2B che ti sta chiamando.\n\n' +
      'Differenza con i sibling: action_webhook_respond = response sincrona allo stesso request del trigger_webhook (1-1 pairing). Se vuoi rispondere SUBITO + continuare workflow async usa responseMode="fire-and-forget" sul trigger (no respond node necessario). Per redirect senza body usa modalità "Redirect" qui invece di costruire location header a mano.\n\n' +
      'Modalità predefinite (zero-config per il caso comune): (a) JSON — body=auto-stringify del JSON config o expression upstream, content-type application/json + charset utf-8, (b) Testo plain, (c) HTML — content-type text/html + charset utf-8 (per SSR detail pages tipo Streammy/cataloghi), (d) Redirect 302/303/307 — solo Location header (preserva method o forza GET secondo status), (e) File binario — body base64 + Content-Disposition attachment con filename, (f) 204 No Content — risposta vuota per ack-only, (g) Custom — full control su body+status+headersJson.\n\n' +
      'Features production: interpolation espressioni nel customBody ({{$node.upstream.json.X}} per dati dinamici da step precedenti), headersJson per CORS/Cache-Control/X-* custom, status preset comuni (200 OK / 201 Created / 202 Accepted / 204 No Content / 302/303 / 400/401/403/404 / 500), supporto streaming download grandi via base64 + bodyIsBase64=true (sentinel runtime decode lazy).\n\n' +
      'Use case: (1) API REST custom che restituisce JSON dopo elaborazione DB (Liara/agent_extractor → DB → respond), (2) endpoint Stripe/PayPal webhook che deve restituire 200 OK ack entro 5s (use fire-and-forget invece se elaborazione lenta), (3) servire HTML SSR dinamico (detail page Streammy + asset signed proxy URL), (4) download fattura PDF generato dal workflow con filename per-customer.\n\n' +
      'Safety budget: max body 50 MB (oltre conviene S3 redirect), interpolation espressioni timeoutate 1s, header iniezione bloccata (no CRLF in valori).',
    configFields: [
      {
        key: 'respondWith',
        label: 'Tipo di risposta',
        type: 'select',
        required: true,
        options: ['json', 'text', 'html', 'redirect', 'binary', 'empty', 'custom'],
        defaultValue: 'json',
        help:
          'json = serializza input come application/json (default per API REST). ' +
          'text = plain text. ' +
          'html = pagina HTML (text/html). ' +
          'redirect = 302 con header Location verso un altro URL. ' +
          'binary = file binario (input atteso in base64, output con il contentType configurato — es. application/pdf, image/png). ' +
          'empty = 204 No Content, nessun body (per webhook ACK silenziosi tipo Slack). ' +
          'custom = controllo totale su body + contentType + headers (per casi avanzati).',
      },

      // ────────── Status code ──────────
      {
        key: 'statusPreset',
        label: 'Codice di stato',
        type: 'select',
        required: false,
        options: [
          '200 OK',
          '201 Created',
          '202 Accepted',
          '204 No Content',
          '301 Moved Permanently',
          '302 Found',
          '304 Not Modified',
          '400 Bad Request',
          '401 Unauthorized',
          '403 Forbidden',
          '404 Not Found',
          '409 Conflict',
          '410 Gone',
          '422 Unprocessable Entity',
          '429 Too Many Requests',
          '500 Internal Server Error',
          '502 Bad Gateway',
          '503 Service Unavailable',
          'Custom (specifica sotto)',
        ],
        defaultValue: '200 OK',
        help:
          'Codice HTTP da restituire. I preset coprono il 95% dei casi. ' +
          'Scegli "Custom" e usa il campo "Status personalizzato" sotto per codici non standard ' +
          '(es. 418 I\'m a teapot, 451 Unavailable for Legal Reasons).',
      },
      {
        key: 'status',
        label: 'Status personalizzato',
        type: 'number',
        required: false,
        placeholder: 'es. 418',
        help: 'Usato SOLO quando "Codice di stato" = Custom. Range 100-599.',
        showIf: { field: 'statusPreset', equals: 'Custom (specifica sotto)' },
      },

      // ────────── JSON / Text / HTML body ──────────
      {
        key: 'body',
        label: 'Body della risposta',
        type: 'expression',
        required: false,
        placeholder:
          '{"ok":true,"data":{{$node.Transform.json}}}    oppure    <html><h1>{{input.title}}</h1></html>',
        help:
          'Contenuto da restituire. Supporta {{espressioni}} con valori dai nodi precedenti. ' +
          'Se VUOTO: per JSON serializza l\'input del nodo precedente; per Text/HTML usa l\'input come stringa.',
        showIf: { field: 'respondWith', in: ['json', 'text', 'html'] },
      },

      // ────────── Redirect ──────────
      {
        key: 'redirectLocation',
        label: 'URL di redirect',
        type: 'expression',
        required: false,
        placeholder: 'https://example.com/grazie  oppure  /pagina/successo?id={{input.orderId}}',
        help:
          'Destinazione del redirect. Può essere assoluto (https://...) o relativo (/path). ' +
          'Imposta automaticamente lo header "Location" e usa status 302 se non specificato.',
        showIf: { field: 'respondWith', equals: 'redirect' },
      },

      // ────────── Binary file ──────────
      {
        key: 'binaryData',
        label: 'Dati binari (base64)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.PDF_Generate.base64}}',
        help:
          'Body binario codificato in base64. Tipicamente l\'output di un nodo File Read o PDF Generate. ' +
          'Viene decodificato server-side prima di scriverlo sulla response.',
        showIf: { field: 'respondWith', equals: 'binary' },
      },
      {
        key: 'binaryContentType',
        label: 'Content-Type binario',
        type: 'select',
        required: false,
        options: [
          'application/pdf',
          'application/zip',
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'image/svg+xml',
          'audio/mpeg',
          'audio/wav',
          'video/mp4',
          'application/octet-stream',
        ],
        defaultValue: 'application/octet-stream',
        help: 'MIME del file binario. application/octet-stream = "scarica come file generico".',
        showIf: { field: 'respondWith', equals: 'binary' },
      },
      {
        key: 'binaryFilename',
        label: 'Nome file (per download)',
        type: 'expression',
        required: false,
        placeholder: 'report-{{input.id}}.pdf',
        help:
          'Quando impostato, aggiunge header Content-Disposition: attachment; filename="..." ' +
          'così il browser apre il dialogo di salvataggio invece di renderizzare inline.',
        showIf: { field: 'respondWith', equals: 'binary' },
      },

      // ────────── Custom mode ──────────
      {
        key: 'contentType',
        label: 'Content-Type personalizzato',
        type: 'select',
        required: false,
        options: [
          'application/json',
          'text/html; charset=utf-8',
          'text/plain; charset=utf-8',
          'application/xml',
          'text/xml',
          'text/csv',
          'application/javascript',
          'application/yaml',
          'application/octet-stream',
        ],
        defaultValue: 'application/json',
        help:
          'MIME esplicito del body. Usato solo in modalità Custom (le altre modalità impostano automaticamente il tipo corretto).',
        showIf: { field: 'respondWith', equals: 'custom' },
      },
      {
        key: 'customBody',
        label: 'Body custom',
        type: 'expression',
        required: false,
        placeholder: 'qualsiasi stringa, supporta {{espressioni}}',
        help: 'Body completamente sotto il tuo controllo. Vuoto = stringa vuota.',
        showIf: { field: 'respondWith', equals: 'custom' },
      },

      // ────────── CORS ──────────
      {
        key: 'corsOrigin',
        label: 'Access-Control-Allow-Origin',
        type: 'text',
        required: false,
        placeholder: '*  oppure  https://miosito.com',
        help:
          'Header CORS. Necessario se la response viene letta da un browser su un dominio diverso. ' +
          '"*" = qualsiasi origine (più permissivo). Per produzione metti il tuo dominio.',
      },

      // ────────── Extra headers ──────────
      {
        key: 'headersJson',
        label: 'Headers HTTP extra',
        type: 'key-value',
        required: false,
        help:
          'Headers aggiuntivi oltre a Content-Type/Location/Content-Disposition (gestiti sopra). ' +
          'Es. Cache-Control=no-cache, X-Request-Id={{$run.id}}, ETag="abc123".',
      },
    ],
    vendor: 'flowforge',
    version: '2.0.0',
  },
};
