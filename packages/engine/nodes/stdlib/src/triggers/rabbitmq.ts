import type { NodeModule } from '../types.js';

/**
 * RabbitMQ trigger — definition-only NodeDef metadata.
 *
 * Consumer AMQP 0-9-1 persistente: si connette a un broker RabbitMQ, consuma una
 * coda e fa partire UN run del workflow per OGNI messaggio. Il loop di consumo,
 * l'ack/nack e la riconnessione sono engine-side (TriggerWatchersService →
 * rabbitmq-watcher); questo file dichiara SOLO i config field, gli help e i
 * default.
 */
export const rabbitmqTriggerNode: NodeModule = {
  def: {
    id: 'trigger_rabbitmq',
    type: 'trigger',
    label: 'RabbitMQ',
    icon: 'rabbit',
    color: '#ff6600',
    description:
      'Avvia il workflow ogni volta che arriva un messaggio su una coda RabbitMQ. Il runtime apre un consumer AMQP 0-9-1 persistente verso il broker e resta in ascolto: ideale per architetture a code dove un producer deposita lavori (ordini, email da inviare, job di elaborazione) e il workflow li processa uno a uno.\n\n' +
      'Differenza con i sibling: trigger_webhook = HTTP in ingresso; trigger_websocket = stream push persistente; trigger_kafka = log distribuito ad alto throughput con consumer group/offset; trigger_rabbitmq = coda di lavoro con ack per-messaggio e requeue. Scegli RabbitMQ quando vuoi una coda di lavoro affidabile con conferma esplicita di elaborazione (work queue), non un log da rileggere.\n\n' +
      'Consegna affidabile (at-least-once, default): il messaggio viene confermato (ACK) al broker SOLO dopo che il run è partito con successo. Se il run fallisce, il messaggio viene rimesso in coda (NACK + requeue) e riconsegnato: nessun lavoro perso su un crash. In modalità "auto" (at-most-once) il broker considera consegnato all\'invio — più veloce ma un run fallito perde il messaggio.\n\n' +
      'Backpressure: "prefetch" limita quanti messaggi non ancora confermati il broker invia in parallelo — è il vero regolatore di carico, evita di sommergere il runtime. Riconnessione automatica con backoff esponenziale (1s→2s→…→30s) su caduta del broker o della rete.\n\n' +
      'Output per ogni messaggio: { data } = payload parsato come JSON quando possibile (altrimenti la stringa grezza), { raw } = testo originale, { receivedAt } = timestamp ISO. Con "JSON Pointer di filtro" processi solo i messaggi che hanno un certo campo.\n\n' +
      "Use case: (1) coda di ordini da un e-commerce → validazione → evasione, (2) job di invio email/PDF depositati da un'altra app → generazione → invio, (3) eventi di dominio da microservizi → sync verso CRM/DB, (4) pipeline di elaborazione immagini/documenti con requeue automatico sui fallimenti.",
    configFields: [
      // ────────── Connessione ──────────
      {
        key: 'url',
        label: 'URL del broker (AMQP)',
        type: 'text',
        required: true,
        placeholder: 'amqps://user:password@broker.example.com:5671/vhost',
        help:
          'URI di connessione AMQP. amqps:// = TLS (raccomandato in produzione), ' +
          'amqp:// = in chiaro (solo reti fidate). Include credenziali e vhost. ' +
          'Il consumer resta connesso finché il workflow è abilitato.',
      },
      {
        key: 'queue',
        label: 'Coda (queue)',
        type: 'text',
        required: true,
        placeholder: 'orders.incoming',
        help:
          'Nome della coda da consumare. Se non esiste viene dichiarata (assertQueue). ' +
          "La durabilità è controllata dall'opzione qui sotto.",
      },
      {
        key: 'durable',
        label: 'Coda durevole',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'On (default): la coda sopravvive al restart del broker. Deve combaciare ' +
          'con come la coda è stata dichiarata dal producer, altrimenti il broker ' +
          'rifiuta la connessione con un errore di parametri incompatibili.',
      },

      // ────────── Consegna ──────────
      {
        key: 'ackMode',
        label: 'Modalità di conferma',
        type: 'select',
        required: false,
        defaultValue: 'manual',
        options: ['manual', 'auto'],
        help:
          'manual (default, consigliata): il messaggio è confermato SOLO se il run ' +
          'parte con successo; su errore torna in coda e viene riconsegnato. ' +
          'Automatica: il broker lo considera consegnato subito — un run fallito lo perde.',
      },
      {
        key: 'prefetch',
        label: 'Prefetch (backpressure)',
        type: 'number',
        required: false,
        defaultValue: '10',
        help:
          'Quanti messaggi non ancora confermati il broker può inviare in parallelo. ' +
          'È il regolatore di carico principale: valori bassi = più prudente, alti = ' +
          'più throughput ma più run concorrenti. Solo in modalità Manuale.',
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
          '"raw" contiene sempre il testo originale del messaggio.',
      },
      {
        key: 'messagePointer',
        label: 'JSON Pointer di filtro/estrazione',
        type: 'text',
        required: false,
        placeholder: '/type   oppure   /event/name',
        help:
          'RFC 6901 JSON Pointer. Se valorizzato, il run parte SOLO se il puntatore ' +
          'risolve a un valore non-undefined (esposto come "matched"). I messaggi ' +
          'senza match vengono comunque confermati al broker (scartati per scelta, ' +
          'non riconsegnati). Vuoto = ogni messaggio fa partire un run.',
      },

      // ────────── Resilienza ──────────
      {
        key: 'maxMessagesPerSec',
        label: 'Budget anti-flood (messaggi/sec)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help:
          'Tetto di run avviati al secondo. I messaggi oltre il budget vengono ' +
          'rimessi in coda (requeue) per non saturare il runtime. 0 = nessun limite ' +
          '(il prefetch fa già da backpressure — di norma basta quello).',
      },
      {
        key: 'reconnect',
        label: 'Riconnessione automatica',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'On (default): su caduta del broker/rete riconnette con backoff esponenziale ' +
          '(1s→2s→…→30s). Off: alla prima disconnessione il consumer si ferma finché ' +
          'non riabiliti/salvi il workflow.',
      },
    ],
    searchAliases: [
      'rabbitmq',
      'rabbit',
      'amqp',
      'message queue',
      'coda',
      'queue',
      'broker',
      'consumer',
      'work queue',
      'mq',
    ],
    /**
     * Cosa il trigger consegna. Rispecchia `triggerInput` di
     * `trigger-watchers/rabbitmq-watcher.ts`.
     */
    outputContract: {
      fields: [
        { name: 'data', type: 'unknown', desc: 'Il messaggio interpretato: oggetto se JSON, stringa altrimenti' },
        { name: 'raw', type: 'string', desc: 'Il messaggio come è arrivato, non interpretato' },
        { name: 'receivedAt', type: 'string', desc: 'Quando è stato consumato, in ISO 8601' },
        {
          name: 'matched',
          type: 'unknown | undefined',
          desc: 'Il valore estratto dal filtro; assente quando nessun filtro è configurato',
        },
      ],
      notes: 'Il messaggio viene confermato al broker appena consegnato al workflow.',
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
