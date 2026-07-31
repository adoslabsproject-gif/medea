/**
 * Collaudo del flusso di eventi: il runtime racconta cosa sta facendo?
 *
 * È la prova che sostituisce l'interrogazione ogni 400 ms. Serve a due cose:
 * vedere i nodi accendersi mentre eseguono, e — più importante — accorgersi
 * delle esecuzioni che parte nessuno, quelle di un cron o di una casella in
 * ascolto, che prima non lasciavano traccia nello storico di Medea.
 *
 * Il collaudo apre il flusso, fa partire un workflow di due nodi e verifica
 * che arrivino, nell'ordine: l'avvio, un passo per nodo, la conclusione.
 *
 * Uso: node scripts/collaudo-eventi.mjs [http://127.0.0.1:PORTA]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:39102';
const EMAIL = 'collaudo@localhost.local';
const PASSWORD = 'Collaudo-Medea-2026!';
/** Oltre questo tempo si dichiara fallito: due nodi banali sono millisecondi. */
const TIMEOUT_MS = 20_000;

let token = '';

async function call(path, init = {}) {
  const response = await fetch(`${BASE}/api/v1${path}`, {
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

/** Lo stesso lettore di `runtime/sse.ts`, in miniatura. */
function reader() {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    const out = [];
    for (const block of blocks) {
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) out.push({ event, data: data.join('\n') });
    }
    return out;
  };
}

async function main() {
  console.log(`Collaudo del flusso di eventi su ${BASE}\n`);
  await authenticate();

  const seen = [];
  const controller = new AbortController();
  const stream = await fetch(`${BASE}/api/v1/dashboard/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!stream.ok) throw new Error(`il flusso ha risposto ${stream.status}`);
  console.log('  Flusso aperto.');

  const read = reader();
  const decoder = new TextDecoder();
  const body = stream.body.getReader();

  const listening = (async () => {
    for (;;) {
      const { done, value } = await body.read();
      if (done) return;
      for (const message of read(decoder.decode(value, { stream: true }))) {
        if (message.event === 'ping' || message.event === 'hello') continue;
        const payload = JSON.parse(message.data);
        seen.push(payload);
        const dettaglio =
          payload.name === 'run.step'
            ? ` ${payload.data.step.nodeId} → ${payload.data.step.status}`
            : payload.name.startsWith('run.')
              ? ` ${payload.data.status ?? ''}`
              : '';
        console.log(`  evento: ${payload.name}${dettaglio}`);
      }
    }
  })();

  const { workflow } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-eventi',
      nodes: [
        { id: 'avvio', defId: 'trigger_manual', x: 0, y: 0, config: {} },
        {
          id: 'conto',
          defId: 'action_run_js',
          x: 220,
          y: 0,
          config: { code: 'return { risultato: 6 * 7 };' },
        },
      ],
      edges: [{ from: 'avvio', to: 'conto' }],
    }),
  });

  await call(`/workflows/${workflow.id}/run`, { method: 'POST', body: JSON.stringify({}) });

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const fine = seen.find((e) => e.name === 'run.completed' || e.name === 'run.errored');
    if (fine) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  controller.abort();
  await listening.catch(() => {});

  const avvio = seen.find((e) => e.name === 'run.started');
  const passi = seen.filter((e) => e.name === 'run.step');
  const fine = seen.find((e) => e.name === 'run.completed');

  console.log('');
  const esito = [
    ['avvio annunciato', Boolean(avvio)],
    ['un passo per nodo', passi.length >= 2],
    ['conclusione annunciata', fine?.data.status === 'success'],
    ['il passo porta il suo esito', passi.some((p) => p.data.step?.status === 'success')],
  ];
  for (const [cosa, ok] of esito) console.log(`  ${ok ? '✓' : '✗'} ${cosa}`);

  if (esito.every(([, ok]) => ok)) {
    console.log('\nFLUSSO CONFERMATO: il runtime racconta l’esecuzione mentre avviene.');
    process.exit(0);
  }
  console.log('\nFLUSSO NON CONFERMATO.');
  process.exit(1);
}

await main();
