/**
 * Collaudo dei webhook: una chiamata da fuori fa partire il workflow?
 *
 * È l'ultimo modo in cui un'automazione può cominciare senza che nessuno
 * prema niente: non l'orologio, non la posta, ma un altro programma che
 * bussa. Serve a incastrare Medea in quello che c'è già sulla macchina.
 *
 * L'indirizzo è **locale**. `127.0.0.1` non è raggiungibile da internet, e
 * questo è quanto un'app senza server può offrire onestamente: vale per un
 * altro programma su questo computer, per uno script, per un tunnel aperto
 * apposta.
 *
 * Perché funzioni il motore va avviato con due variabili, che è esattamente
 * quello che fa Medea:
 *   FLOWFORGE_SSO_SECRET       da cui si deriva il token nell'indirizzo
 *   FLOWFORGE_PUBLIC_BASE_URL  per comporre l'indirizzo completo
 *
 * Senza la prima l'endpoint risponde «token non derivabile»; senza la
 * seconda restituisce un percorso senza sapere dove attaccarlo.
 *
 * Uso: node scripts/collaudo-webhook.mjs [http://127.0.0.1:PORTA]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:39100';
const EMAIL = 'collaudo@localhost.local';
const PASSWORD = 'Collaudo-Medea-2026!';

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

async function main() {
  console.log(`Collaudo dei webhook su ${BASE}\n`);
  await authenticate();

  const { workflow } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-webhook',
      nodes: [
        { id: 'ingresso', defId: 'trigger_webhook', x: 0, y: 0, config: {} },
        {
          id: 'eco',
          defId: 'action_run_js',
          x: 220,
          y: 0,
          config: { code: 'return { ricevuto: input.body };' },
        },
      ],
      edges: [{ from: 'ingresso', to: 'eco' }],
      enabled: true,
    }),
  });
  console.log(`  Workflow creato: ${workflow.id}`);

  const { webhook } = await call(`/workflows/${workflow.id}/webhook-url`);
  if (!webhook.url) {
    console.log('\n✗ Nessun indirizzo: il motore non ha FLOWFORGE_PUBLIC_BASE_URL.');
    process.exit(1);
  }
  console.log(`  Indirizzo: ${webhook.url}`);

  const risposta = await fetch(webhook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ordine: 'A-42' }),
  });
  const accettata = risposta.ok;
  console.log(`  Chiamata da fuori: ${String(risposta.status)}`);

  // La chiamata è accettata subito, l'esecuzione avviene poco dopo.
  let run = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { runs } = await call(`/runs?workflowId=${workflow.id}`);
    if (runs.length > 0) {
      run = await call(`/runs/${runs[0].id}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const passo = run?.run.steps.find((s) => s.nodeId === 'eco');
  if (run) {
    console.log(`  Esecuzione: ${run.run.status} · avviata da ${run.run.triggerType}`);
    console.log(`  Il corpo è arrivato: ${passo?.output ?? '—'}`);
  }

  console.log('');
  const esito = [
    ['l’indirizzo esiste', Boolean(webhook.url)],
    ['la chiamata viene accettata', accettata],
    ['l’esecuzione parte', run?.run.status === 'success'],
    ['il motore la attribuisce al webhook', run?.run.triggerType === 'webhook'],
    ['il corpo della chiamata arriva ai nodi', Boolean(passo?.output?.includes('A-42'))],
  ];
  for (const [cosa, ok] of esito) console.log(`  ${ok ? '✓' : '✗'} ${cosa}`);

  if (esito.every(([, ok]) => ok)) {
    console.log('\nWEBHOOK CONFERMATI: si può far partire un workflow bussando da fuori.');
    process.exit(0);
  }
  console.log('\nWEBHOOK NON CONFERMATI.');
  process.exit(1);
}

await main();
