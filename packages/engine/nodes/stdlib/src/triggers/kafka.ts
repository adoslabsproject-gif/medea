import type { NodeModule } from '../types.js';

/**
 * Apache Kafka trigger — definition-only NodeDef metadata.
 *
 * Consumer Kafka persistente (consumer group + offset commit): si connette a un
 * cluster, consuma un topic e fa partire UN run del workflow per OGNI messaggio.
 * Il loop di consumo, il commit dell'offset e la riconnessione sono engine-side
 * (TriggerWatchersService → kafka-watcher); questo file dichiara SOLO i config
 * field, gli help e i default.
 */
export const kafkaTriggerNode: NodeModule = {
  def: {
    id: 'trigger_kafka',
    type: 'trigger',
    label: 'Apache Kafka',
    icon: 'activity',
    color: '#231f20',
    description:
      "Avvia il workflow ogni volta che arriva un messaggio su un topic Apache Kafka. Il runtime apre un consumer con consumer group e commit dell'offset: ideale per pipeline event-driven ad alto throughput dove più servizi pubblicano eventi su un log distribuito e il workflow li elabora.\n\n" +
      'Differenza con i sibling: trigger_rabbitmq = work queue con ack per-messaggio e requeue; trigger_kafka = log distribuito partizionato con offset e consumer group (scalabilità orizzontale, replay dal passato); trigger_websocket = stream push; trigger_webhook = HTTP in ingresso. Scegli Kafka quando hai grandi volumi di eventi, più consumer che devono scalare in parallelo, o vuoi poter rileggere lo storico.\n\n' +
      'Consumer group: il "Group ID" identifica il gruppo di consumer che si spartiscono le partizioni del topic. Più container/istanze con lo STESSO group id scalano il consumo in parallelo (ognuno prende un sottoinsieme di partizioni). Lascialo vuoto per un id dedicato a questo workflow.\n\n' +
      "Consegna at-least-once: l'offset viene committato SOLO dopo che il run è partito con successo. Se il run fallisce, l'offset non avanza e il messaggio viene ri-consumato: nessun evento perso su un crash. \"Leggi dall'inizio\" ricomincia dall'offset più vecchio disponibile (utile per un backfill iniziale); di default riparte dall'ultimo offset committato del gruppo.\n\n" +
      'Sicurezza: TLS (ssl) e autenticazione SASL (PLAIN o SCRAM-SHA-256/512) per i cluster gestiti (Confluent Cloud, AWS MSK, Aiven, Redpanda). Usa le espressioni {{secrets.X}} per non incollare le credenziali in chiaro nel nodo.\n\n' +
      'Output per ogni messaggio: { data } = payload parsato JSON quando possibile (altrimenti stringa), { raw } = testo originale, { topic }, { partition }, { receivedAt }. Con "JSON Pointer di filtro" processi solo i messaggi che hanno un certo campo.\n\n' +
      'Use case: (1) eventi di dominio da microservizi → proiezione su DB/CRM, (2) click/telemetria ad alto volume → aggregazione → alert, (3) change-data-capture (Debezium) → sync verso sistemi esterni, (4) pipeline di elaborazione ordini con replay in caso di errore.',
    configFields: [
      // ────────── Connessione ──────────
      {
        key: 'brokers',
        label: 'Broker (host:porta, separati da virgola)',
        type: 'text',
        required: true,
        placeholder: 'kafka1.example.com:9092, kafka2.example.com:9092',
        help:
          'Lista dei bootstrap broker del cluster, separati da virgola. Ne basta ' +
          'uno raggiungibile: il client scopre gli altri. Formato host:porta.',
      },
      {
        key: 'topic',
        label: 'Topic',
        type: 'text',
        required: true,
        placeholder: 'orders.events',
        help: 'Nome del topic da consumare. Il consumer si sottoscrive a tutte le sue partizioni.',
      },
      {
        key: 'groupId',
        label: 'Consumer Group ID',
        type: 'text',
        required: false,
        placeholder: 'flowforge-orders-processor',
        help:
          'Identifica il gruppo di consumer che si spartiscono le partizioni. Più ' +
          'istanze con lo stesso id scalano in parallelo. Vuoto = id dedicato a ' +
          'questo workflow (flowforge-<workflowId>).',
      },
      {
        key: 'fromBeginning',
        label: "Leggi dall'inizio (primo avvio)",
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          "On: al primo avvio del gruppo consuma dall'offset più vecchio disponibile " +
          "(backfill dello storico). Off (default): riparte dall'ultimo offset " +
          'committato dal gruppo (solo i nuovi messaggi).',
      },

      // ────────── Sicurezza ──────────
      {
        key: 'ssl',
        label: 'TLS (ssl)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'On per i cluster che richiedono connessione cifrata (quasi tutti i gestiti: Confluent, MSK, Aiven).',
      },
      {
        key: 'saslMechanism',
        label: 'Autenticazione SASL',
        type: 'select',
        required: false,
        defaultValue: 'none',
        options: ['none', 'plain', 'scram-sha-256', 'scram-sha-512'],
        help:
          'Meccanismo SASL. none = nessuna auth (broker aperti / reti fidate). ' +
          'plain / scram-sha-256 / scram-sha-512 per i cluster gestiti. Richiede ' +
          'username e password qui sotto.',
      },
      {
        key: 'saslUsername',
        label: 'SASL username / API key',
        type: 'text',
        required: false,
        placeholder: '{{secrets.KAFKA_KEY}}',
        help: 'Username SASL (o API key per Confluent Cloud). Usa {{secrets.X}} per non incollarlo in chiaro.',
      },
      {
        key: 'saslPassword',
        label: 'SASL password / API secret',
        type: 'text',
        required: false,
        placeholder: '{{secrets.KAFKA_SECRET}}',
        help: 'Password SASL (o API secret). Usa {{secrets.X}} dalle Variabili tenant: non incollare segreti nel nodo.',
      },

      // ────────── Filtro / parsing ──────────
      {
        key: 'jsonParse',
        label: 'Parsa i messaggi come JSON',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'On (default): il payload viene parsato come JSON in "data" (fallback alla ' +
          'stringa grezza se non è JSON valido). Off: "data" resta la stringa. ' +
          '"raw" contiene sempre il testo originale.',
      },
      {
        key: 'messagePointer',
        label: 'JSON Pointer di filtro/estrazione',
        type: 'text',
        required: false,
        placeholder: '/eventType   oppure   /payload/status',
        help:
          'RFC 6901 JSON Pointer. Se valorizzato, il run parte SOLO se il puntatore ' +
          'risolve a un valore non-undefined (esposto come "matched"). I messaggi ' +
          "senza match avanzano comunque l'offset (scartati per scelta). Vuoto = " +
          'ogni messaggio fa partire un run.',
      },

      // ────────── Resilienza ──────────
      {
        key: 'maxMessagesPerSec',
        label: 'Budget anti-flood (messaggi/sec)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help:
          'Tetto di run avviati al secondo. Oltre il budget i messaggi avanzano ' +
          "l'offset senza far partire un run (scartati) per proteggere il runtime. " +
          '0 = nessun limite. In Kafka il consumer group + partizioni già distribuiscono il carico.',
      },
      {
        key: 'reconnect',
        label: 'Riconnessione automatica',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'On (default): su crash del consumer riconnette con backoff esponenziale ' +
          '(1s→2s→…→30s). Off: alla prima caduta il consumer si ferma finché non ' +
          'riabiliti/salvi il workflow.',
      },
    ],
    searchAliases: [
      'kafka',
      'apache kafka',
      'confluent',
      'redpanda',
      'msk',
      'event stream',
      'streaming',
      'consumer',
      'topic',
      'broker',
      'event bus',
      'mq',
    ],
    /**
     * Cosa il trigger consegna. Rispecchia `triggerInput` di
     * `trigger-watchers/kafka-watcher.ts`.
     */
    outputContract: {
      fields: [
        { name: 'data', type: 'unknown', desc: 'Il messaggio interpretato: oggetto se JSON, stringa altrimenti' },
        { name: 'raw', type: 'string', desc: 'Il messaggio come è arrivato, non interpretato' },
        { name: 'receivedAt', type: 'string', desc: 'Quando è stato consumato, in ISO 8601' },
        { name: 'topic', type: 'string', desc: 'Il topic da cui proviene' },
        { name: 'partition', type: 'number', desc: 'La partizione da cui proviene' },
        {
          name: 'matched',
          type: 'unknown | undefined',
          desc: 'Il valore estratto dal filtro; assente quando nessun filtro è configurato',
        },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
