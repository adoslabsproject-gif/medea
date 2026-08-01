import type { NodeModule } from '../types.js';

/**
 * WebSocket trigger — definition-only NodeDef metadata.
 *
 * Apre una connessione WebSocket CLIENT persistente verso un endpoint esterno
 * (`ws://` / `wss://`) e fa partire UN run del workflow per OGNI messaggio
 * ricevuto. È il sibling "push real-time" dei trigger: dove trigger_webhook
 * ASPETTA che qualcuno chiami il tuo URL, trigger_websocket si CONNETTE lui a
 * uno stream remoto e resta in ascolto.
 *
 * Il loop di connessione è engine-side (TriggerWatchersService): apre il socket,
 * invia l'eventuale messaggio di subscribe, riconnette con backoff esponenziale
 * su drop, e fa keepalive ping/pong. Questo file dichiara SOLO i config field,
 * gli help e la validazione — la runtime legge la def dal registry e cabla il
 * watcher.
 */
export const websocketTriggerNode: NodeModule = {
  def: {
    id: 'trigger_websocket',
    type: 'trigger',
    label: 'WebSocket',
    icon: 'plug-zap',
    color: '#22c55e',
    description:
      'Avvia il workflow in tempo reale ogni volta che arriva un messaggio su una connessione WebSocket. A differenza di trigger_webhook (endpoint HTTP che ASPETTA chiamate in ingresso), questo nodo si CONNETTE attivamente a uno stream remoto (ws:// o wss://) e resta in ascolto persistente: ideale per feed live dove il dato arriva push, non su richiesta.\n\n' +
      'Differenza con i sibling: trigger_webhook = HTTP request/response in ingresso; trigger_websocket = socket persistente in uscita verso un server esterno; trigger_imap = polling email; trigger_db_change = polling tabella; trigger_cron = schedulato. Usa WebSocket quando la latenza conta e il provider espone uno stream (prezzi crypto/borsa, presence/chat, eventi IoT/MQTT-over-WS, notifiche broker, log streaming).\n\n' +
      'Connessione: URL ws:// (plain) o wss:// (TLS, raccomandato in produzione). Header di connessione opzionali in JSON (es. Authorization Bearer, Cookie, Sec-WebSocket-Protocol via header) per autenticare l\'handshake. Molti provider richiedono un messaggio di "subscribe" subito dopo l\'apertura: impostalo in "Messaggio di subscribe" (JSON inviato on-open, anche dopo ogni riconnessione).\n\n' +
      'Resilienza production-grade: riconnessione automatica con backoff esponenziale (1s→2s→4s… cap 30s) su chiusura o errore, keepalive ping/pong configurabile per non farsi droppare da proxy/load-balancer, e un budget anti-flood (max messaggi/sec) che evita di saturare il runtime se lo stream è troppo verboso.\n\n' +
      'Output del trigger per ogni messaggio: { data } = payload già parsato come JSON quando possibile (altrimenti la stringa grezza), { raw } = testo originale del frame, { receivedAt } = timestamp ISO. Con "JSON Pointer di filtro" estrai/filtri un sottocampo (es. /type per branchare solo su certi eventi) senza un nodo aggiuntivo.\n\n' +
      'Use case: (1) prezzi crypto live da exchange (Binance/Coinbase ws stream) → branch su soglia → notifica, (2) eventi chat/presence di un broker realtime → persistenza DB, (3) telemetria IoT su WebSocket → aggregazione → alert, (4) stream di eventi da un SaaS (es. trading, logistica) → sync verso CRM. Per stream ad altissima frequenza valuta un filtro server-side o il budget anti-flood.',
    configFields: [
      // ────────── Connessione ──────────
      {
        key: 'url',
        label: 'URL WebSocket',
        type: 'text',
        required: true,
        placeholder: 'wss://stream.example.com/ws',
        help:
          'Endpoint a cui connettersi. wss:// = cifrato (TLS, raccomandato). ' +
          'ws:// = in chiaro (solo reti fidate). La connessione resta aperta e ' +
          'persistente finché il workflow è abilitato.',
      },
      {
        key: 'headersJson',
        label: 'Header di connessione (JSON)',
        type: 'json',
        required: false,
        language: 'json',
        placeholder: '{ "Authorization": "Bearer xxx" }',
        help:
          'Header inviati durante l\'handshake HTTP di upgrade. Oggetto JSON ' +
          'chiave→valore. Usali per autenticare (Bearer, Cookie, API key) o per ' +
          'negoziare un sub-protocollo. Vuoto = nessun header custom.',
      },
      {
        key: 'subscribeMessage',
        label: 'Messaggio di subscribe (on-open)',
        type: 'textarea',
        required: false,
        placeholder: '{ "op": "subscribe", "channel": "trades" }',
        help:
          'Messaggio inviato SUBITO dopo l\'apertura della connessione (e dopo ' +
          'ogni riconnessione). Tipicamente un JSON di subscribe richiesto dal ' +
          'provider per iniziare a ricevere lo stream. Vuoto = nessun invio.',
      },

      // ────────── Filtro / parsing ──────────
      {
        key: 'jsonParse',
        label: 'Parsa i messaggi come JSON',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'On (default): ogni frame viene parsato come JSON in "data" (fallback ' +
          'alla stringa grezza se non è JSON valido). Off: "data" resta sempre ' +
          'la stringa testuale del frame. "raw" contiene sempre il testo originale.',
      },
      {
        key: 'messagePointer',
        label: 'JSON Pointer di filtro/estrazione',
        type: 'text',
        required: false,
        placeholder: '/type   oppure   /data/price',
        help:
          'RFC 6901 JSON Pointer. Se valorizzato, il run parte SOLO se il puntatore ' +
          'risolve a un valore non-undefined, e quel valore viene esposto come ' +
          '"matched". Es. "/type" filtra i messaggi che hanno un campo type. ' +
          'Vuoto = ogni messaggio fa partire un run.',
      },

      // ────────── Resilienza ──────────
      {
        key: 'reconnect',
        label: 'Riconnessione automatica',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'On (default): su chiusura/errore riconnette con backoff esponenziale ' +
          '(1s→2s→4s… max 30s). Off: alla prima disconnessione il watcher si ferma ' +
          'finché non riabiliti/salvi il workflow.',
      },
      {
        key: 'pingIntervalSec',
        label: 'Keepalive ping (secondi)',
        type: 'number',
        required: false,
        defaultValue: '30',
        help:
          'Intervallo dei ping di keepalive per non farsi chiudere la connessione ' +
          'da proxy/load-balancer inattivi. 0 = disabilitato. Default 30s. ' +
          'Molti provider chiudono i socket idle dopo 60s.',
      },
      {
        key: 'maxMessagesPerSec',
        label: 'Budget anti-flood (messaggi/sec)',
        type: 'number',
        required: false,
        defaultValue: '20',
        help:
          'Tetto di run avviati al secondo da questo trigger. I messaggi oltre il ' +
          'budget vengono scartati (con log) per proteggere il runtime da stream ' +
          'troppo verbosi. 0 = nessun limite (usa con cautela).',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
