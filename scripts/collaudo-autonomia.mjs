/**
 * Collaudo dell'autonomia: il workflow parte **da solo**?
 *
 * È la domanda che separa un editor da un prodotto. Il collaudo precedente
 * dimostra che i nodi eseguono quando si preme un pulsante; questo dimostra
 * che eseguono anche quando non c'è nessuno a premerlo.
 *
 * Il caso di prova è un cron ogni minuto: si crea, si attiva, si aspetta, e
 * si guarda se lo storico si è riempito senza che nessuno abbia chiesto
 * niente.
 *
 * Uso: node scripts/collaudo-autonomia.mjs [http://127.0.0.1:PORTA]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:39102';
const EMAIL = 'collaudo@localhost.local';
const PASSWORD = 'Collaudo-Medea-2026!';
/** Quanto si aspetta che il cron scatti: un minuto, più il margine. */
const WAIT_MS = 90_000;

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
  console.log(`Collaudo dell'autonomia su ${BASE}\n`);
  await authenticate();

  // Un cron che scatta ogni minuto, e un nodo che lascia una traccia.
  const { workflow } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-autonomia',
      nodes: [
        {
          id: 'ogni_minuto',
          defId: 'trigger_cron',
          x: 0,
          y: 0,
          config: { cronExpression: '* * * * *', timezone: 'Europe/Rome' },
        },
        {
          id: 'traccia',
          defId: 'action_run_js',
          x: 220,
          y: 0,
          config: { code: 'return { partito: true, quando: new Date().toISOString() };' },
        },
      ],
      edges: [{ from: 'ogni_minuto', to: 'traccia' }],
    }),
  });

  console.log(`  Workflow creato: ${workflow.id}`);

  await call(`/workflows/${workflow.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'collaudo-autonomia',
      nodes: workflow.nodes,
      edges: workflow.edges,
      enabled: true,
    }),
  });
  console.log('  Workflow attivato.');
  console.log(
    "  NOTA: lo scheduler carica i cron solo all'avvio, quindi va riavviato.\n" +
      '        È quello che fa Medea quando premi «Attivo».\n',
  );

  const deadline = Date.now() + WAIT_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    const { runs } = await call(`/runs?workflowId=${workflow.id}`);
    if (Array.isArray(runs) && runs.length > seen) {
      seen = runs.length;
      const last = runs[0];
      console.log(
        `  È partito da solo: run ${last.id}, stato ${last.status}, avviata ${last.startedAt}`,
      );
      if (last.status === 'success') {
        console.log('\nAUTONOMIA CONFERMATA: il cron ha eseguito senza intervento.');
        process.exit(0);
      }
    }
    const secondi = Math.round((deadline - Date.now()) / 1000);
    process.stdout.write(`\r  In attesa del cron… ${String(secondi)}s   `);
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log('\n\nAUTONOMIA NON CONFERMATA: nessuna esecuzione in un minuto e mezzo.');
  process.exit(1);
}

await main();
