import type { NodeDef } from '@medea/engine-core-schema';

export const openapiNodeDef: NodeDef = {
  id: 'action_openapi',
  type: 'action',
  label: 'OpenAPI Connector',
  icon: 'plug',
  color: '#6366f1',
  description:
    "Connettore universale: esegue qualunque API REST descritta da una spec OpenAPI 3.0 (Swagger). Invece di un nodo dedicato per ogni servizio, incolli la spec del provider (Stripe, Slack, Notion, GitHub, il tuo gestionale…) e scegli l'operation: un solo nodo copre migliaia di endpoint.\n\n" +
    "Come funziona: 1) incolla la spec OpenAPI in JSON, 2) indica l'operationId dell'endpoint, 3) passa i parametri (path/query/header) come oggetto JSON. Il nodo costruisce automaticamente l'URL sostituendo i path param (es. /users/{id}), aggiunge query e header, esegue la chiamata e ritorna status + body parsato.\n\n" +
    'Auth: header configurabile (Authorization: Bearer …, X-API-Key, ecc.) con valore tenuto come secret. Base URL preso da servers[] della spec o sovrascrivibile. Timeout configurabile. SSRF-safe (assertUrlSafe) come tutti i nodi HTTP.\n\n' +
    "Use case: (1) integrare un SaaS che ha OpenAPI ma non un nodo dedicato, (2) chiamare un'API interna aziendale documentata, (3) prototipare un'integrazione prima di costruire un community node dedicato. Per chiamate HTTP arbitrarie senza spec usa action_http; per integrazioni con auth OAuth complesso valuta un community node.",
  configFields: [
    {
      key: 'specJson',
      label: 'Spec OpenAPI 3.0 (JSON)',
      type: 'json',
      required: true,
      language: 'json',
      help: 'La spec del provider in JSON. Da servers[] viene preso il base URL; da paths le operations disponibili.',
    },
    {
      key: 'operationId',
      label: 'Operation ID',
      type: 'text',
      required: true,
      placeholder: 'getUser',
      help: 'L\'operationId dell\'endpoint da chiamare (come nella spec). Se manca nella spec, usa "METHOD /path" (es. "GET /users").',
    },
    {
      key: 'baseUrl',
      label: 'Base URL (override)',
      type: 'text',
      required: false,
      placeholder: 'https://api.example.com/v1',
      help: 'Sovrascrive il server della spec. Vuoto = primo servers[].url della spec.',
    },
    {
      key: 'paramsJson',
      label: 'Parametri (JSON)',
      type: 'json',
      required: false,
      language: 'json',
      placeholder: '{ "id": "42", "fields": "name,email" }',
      help: "Oggetto chiave→valore per i parametri path/query/header dell'operation. I path param obbligatori mancanti danno errore.",
    },
    {
      key: 'bodyJson',
      label: 'Request body (JSON)',
      type: 'json',
      required: false,
      language: 'json',
      help: 'Body inviato per le operations che lo accettano (POST/PUT/PATCH con requestBody). Content-Type application/json automatico.',
    },
    {
      key: 'authHeader',
      label: 'Header di autenticazione',
      type: 'text',
      required: false,
      placeholder: 'Authorization',
      help: "Nome dell'header auth (es. Authorization, X-API-Key). Vuoto = nessuna auth.",
    },
    {
      key: 'authValue',
      label: 'Valore autenticazione',
      type: 'secret',
      required: false,
      placeholder: 'Bearer sk_live_…',
      help: "Valore dell'header auth. Tenuto come secret.",
    },
    {
      key: 'timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
      required: false,
      defaultValue: '30000',
      help: 'Timeout della richiesta in millisecondi. Default 30s.',
    },
  ],
  outputs: ['status', 'operationId', 'data'],
  outputContract: {
    notes: 'Chiama un\'operazione descritta in una specifica OpenAPI. La risposta sta in `data`, con la forma che le da` quell\'API. Uno stato 4xx o 5xx non solleva un errore di suo: va guardato `status`.',
    fields: [
      { name: 'status', type: 'number', desc: 'Il codice HTTP della risposta.' },
      { name: 'operationId', type: 'string', desc: 'L\'operazione chiamata, come si chiama nella specifica.' },
      { name: 'data', type: 'object|array|string', desc: 'Il corpo della risposta, con la forma che ha in quella API.' },
    ],
  },
  vendor: 'flowforge',
  version: '1.0.0',
};
