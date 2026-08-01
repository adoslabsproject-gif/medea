/**
 * Collaudo del relay: una chiamata da internet arriva a un computer di casa?
 *
 * È l'unica funzione di Medea che richiede un server, e la ragione è
 * geografica prima che tecnica: un computer dietro NAT non è raggiungibile
 * dall'esterno. Può però aprire un canale **in uscita** — ed è quello che si
 * verifica qui.
 *
 * Il collaudo mette in scena tutte e tre le parti su questa macchina:
 *
 *   il motore dei workflow   ← quello vero, col webhook di un workflow vero
 *   il relay                 ← quello che verrà messo in produzione
 *   il client                ← lo stesso protocollo che parla Medea
 *
 * e poi bussa al relay come farebbe un servizio esterno. Se il workflow
 * esegue, il giro funziona.
 *
 * Verifica anche il confine che conta: un percorso che NON è un webhook deve
 * essere rifiutato. Senza quel controllo il relay sarebbe un tunnel verso
 * tutta l'API locale del motore, e basterebbe conoscere l'identificativo
 * pubblico per usarlo.
 *
 * Uso:
 *   node scripts/collaudo-relay.mjs [motore] [relay]
 *
 * Esempi:
 *   node scripts/collaudo-relay.mjs
 *   node scripts/collaudo-relay.mjs http://127.0.0.1:39100 https://automazionezeli.com/relay
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const MOTORE = process.argv[2] ?? 'http://127.0.0.1:39100';

/**
 * Il relay da provare.
 *
 * Senza argomento se ne avvia uno qui e si prova contro quello. Con un
 * indirizzo — `https://automazionezeli.com/relay` — si prova quello VERO, in
 * produzione, che è l'unica prova che conta davvero: in mezzo ci sono
 * Cloudflare e nginx, e un WebSocket può inciampare in entrambi senza che
 * niente lo faccia sospettare in locale.
 */
const RELAY_ESTERNO = process.argv[3] ?? '';
const RELAY_PORT = 39500;
const RELAY = RELAY_ESTERNO || `http://127.0.0.1:${String(RELAY_PORT)}/relay`;
/**
 * Il relay compilato, quando se ne avvia uno qui.
 *
 * Dall'ambiente e non scritto qui dentro: vale lo stesso motivo dell'altro
 * script — un percorso assoluto in un repository pubblico racconta com'è
 * fatto il computer di chi lo ha scritto, e funziona solo su quello.
 */
const RELAY_ENTRY = process.env.WEBHOOK_RELAY_ENTRY ?? '../zeliAI/apps/webhook-relay/dist/index.js';

const EMAIL = 'collaudo@localhost.local';
const PASSWORD = 'Collaudo-Medea-2026!';

let token = '';

async function call(path, init = {}) {
  const response = await fetch(`${MOTORE}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function authenticate() {
  const body = JSON.stringify({ email: EMAIL, password: PASSWORD });
  try {
    ({ token } = await call('/auth/login', { method: 'POST', body }));
  } catch {
    await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: 'Collaudo' }),
    });
    ({ token } = await call('/auth/login', { method: 'POST', body }));
  }
}

/** Il client: lo stesso protocollo di `runtime/relay.ts`, in miniatura. */
function connectClient(secret) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/socket`);
    const forwardable = /^\/webhooks\/[A-Za-z0-9/_-]*$/;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: secret }));
    });

    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);

      if (frame.type === 'ready') {
        resolve({ installId: frame.installId, close: () => ws.close() });
        return;
      }

      if (frame.type === 'request') {
        void (async () => {
          // Lo stesso confine che applica Medea. Ripetuto di proposito: è la
          // cosa che non deve fallire nemmeno se l'altra metà cambia.
          if (!forwardable.test(frame.path.split('?')[0])) {
            ws.send(
              JSON.stringify({
                type: 'response',
                id: frame.id,
                status: 403,
                body: JSON.stringify({ error: 'Solo i webhook passano da qui.' }),
              }),
            );
            return;
          }
          const response = await fetch(`${MOTORE}${frame.path}`, {
            method: frame.method,
            headers: frame.headers,
            ...(frame.method === 'GET' ? {} : { body: frame.body }),
          });
          ws.send(
            JSON.stringify({
              type: 'response',
              id: frame.id,
              status: response.status,
              body: await response.text(),
            }),
          );
        })();
      }
    });

    ws.addEventListener('error', () => {
      reject(new Error('il client non si è collegato al relay'));
    });
  });
}

async function attendi(condizione, entro = 15_000) {
  const deadline = Date.now() + entro;
  while (Date.now() < deadline) {
    const risultato = await condizione();
    if (risultato) return risultato;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log(`Collaudo del relay\n  motore: ${MOTORE}\n  relay:  ${RELAY}\n`);
  await authenticate();

  let relay = null;
  if (!RELAY_ESTERNO) {
    console.log('  Avvio un relay qui…');
    relay = spawn('node', [RELAY_ENTRY], {
      env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  } else {
    console.log('  Uso il relay in produzione.');
  }

  const vivo = await attendi(async () => {
    try {
      return (await fetch(`${RELAY}/health`)).ok;
    } catch {
      return false;
    }
  });
  if (!vivo) {
    relay?.kill();
    console.log('\n✗ Il relay non risponde.');
    process.exit(1);
  }

  // Il segreto dell'installazione. L'identificativo pubblico ne è l'impronta.
  const secret = randomBytes(32).toString('hex');
  const atteso = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 24);

  const client = await connectClient(secret);
  console.log(`  Client collegato: ${client.installId}`);

  const { workflow } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-relay',
      nodes: [
        { id: 'ingresso', defId: 'trigger_webhook', x: 0, y: 0, config: {} },
        {
          id: 'eco',
          defId: 'action_run_js',
          x: 220,
          y: 0,
          config: { code: 'return { daInternet: input.body };' },
        },
      ],
      edges: [{ from: 'ingresso', to: 'eco' }],
      enabled: true,
    }),
  });

  const { webhook } = await call(`/workflows/${workflow.id}/webhook-url`);
  const pubblico = `${RELAY}/h/${client.installId}${webhook.path}`;
  console.log(`  Indirizzo pubblico: ${pubblico}`);

  const risposta = await fetch(pubblico, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ da: 'internet' }),
  });
  console.log(`  Chiamata dall'esterno: ${String(risposta.status)}`);

  const run = await attendi(async () => {
    const { runs } = await call(`/runs?workflowId=${workflow.id}`);
    return runs.length > 0 ? call(`/runs/${runs[0].id}`) : null;
  });
  const passo = run?.run.steps.find((s) => s.nodeId === 'eco');

  // Il confine: un percorso che non è un webhook non deve passare.
  const intruso = await fetch(`${RELAY}/h/${client.installId}/api/v1/workflows`);
  console.log(`  Tentativo su un percorso non-webhook: ${String(intruso.status)}`);

  // E un identificativo che non esiste non deve rivelare se esiste o no.
  const sconosciuto = await fetch(`${RELAY}/h/${'0'.repeat(24)}/webhooks/x/y`, {
    method: 'POST',
  });

  client.close();
  relay?.kill();

  console.log('');
  const esito = [
    ["l'identificativo è l'impronta del token", client.installId === atteso],
    ['la chiamata dall’esterno viene accettata', risposta.ok],
    ['il workflow esegue', run?.run.status === 'success'],
    ['il corpo arriva fino ai nodi', Boolean(passo?.output?.includes('internet'))],
    ['un percorso non-webhook viene rifiutato', intruso.status === 403],
    ['un identificativo scollegato dà 503', sconosciuto.status === 503],
  ];
  for (const [cosa, ok] of esito) console.log(`  ${ok ? '✓' : '✗'} ${cosa}`);

  if (esito.every(([, ok]) => ok)) {
    console.log('\nRELAY CONFERMATO: da internet si arriva al computer, e solo ai webhook.');
    process.exit(0);
  }
  console.log('\nRELAY NON CONFERMATO.');
  process.exit(1);
}

await main();
