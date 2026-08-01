/**
 * Collaudo del subworkflow: un workflow può chiamarne un altro?
 *
 * L'esecutore c'è da sempre nel motore, completo di tetto alla profondità e
 * guardia contro l'auto-chiamata. Ma chiama `FLOWFORGE_RUNTIME_URL`, che in
 * mancanza vale `127.0.0.1:3100` — la porta di FlowForge sul server, dove sul
 * computer di casa non c'è niente — e si autentica con
 * `FLOWFORGE_INTERNAL_TOKEN`, che senza sarebbe una richiesta rifiutata.
 *
 * Questo collaudo verifica che le due variabili siano quelle giuste, e che le
 * protezioni continuino a proteggere:
 *
 *   1. un workflow ne chiama un altro, e il chiamato parte davvero
 *   2. un workflow che chiama SÉ STESSO viene fermato
 *
 * Il secondo punto conta quanto il primo: senza, una ricorsione riempie il
 * disco di esecuzioni e satura la macchina.
 *
 * ───── Che «aspetta» aspetti davvero ─────
 *
 * `POST /workflows/:id/run` risponde `202` appena la run è in coda — è
 * asincrono di proposito, per non morire sui workflow che durano minuti — e
 * per un po' l'esecutore restituiva quella risposta come risultato: il
 * chiamante riceveva `status: running` e zero passi, cioè un'esecuzione
 * appena nata invece dell'output del sub.
 *
 * Adesso l'esecutore interroga `GET /runs/:id` finché la run non è in uno
 * stato terminale, e questo collaudo lo verifica: se qualcuno tornasse alla
 * risposta immediata, l'ultimo controllo fallirebbe.
 *
 * Uso: node scripts/collaudo-subworkflow.mjs [http://127.0.0.1:PORTA]
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

async function attendi(condizione, entro = 20_000) {
  const deadline = Date.now() + entro;
  while (Date.now() < deadline) {
    const risultato = await condizione();
    if (risultato) return risultato;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log(`Collaudo del subworkflow su ${BASE}\n`);
  await authenticate();

  // ── Il workflow chiamato: fa una cosa sola, riconoscibile ──────────────
  const { workflow: figlio } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-sub-figlio',
      nodes: [
        { id: 'avvio', defId: 'trigger_manual', x: 0, y: 0, config: {} },
        {
          id: 'lavora',
          defId: 'action_run_js',
          x: 220,
          y: 0,
          config: { code: "return { fatto: 'dal figlio' };" },
        },
      ],
      edges: [{ from: 'avvio', to: 'lavora' }],
    }),
  });
  console.log(`  Figlio: ${figlio.id}`);

  // ── Il chiamante ──────────────────────────────────────────────────────
  const { workflow: padre } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-sub-padre',
      nodes: [
        { id: 'avvio', defId: 'trigger_manual', x: 0, y: 0, config: {} },
        {
          id: 'chiama',
          defId: 'logic_subworkflow',
          x: 220,
          y: 0,
          config: { workflowId: figlio.id, wait: 'true' },
        },
      ],
      edges: [{ from: 'avvio', to: 'chiama' }],
    }),
  });

  const { runId } = await call(`/workflows/${padre.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ input: {} }),
  });

  const esecuzione = await attendi(async () => {
    const d = await call(`/runs/${runId}`);
    return ['success', 'error', 'partial'].includes(d.run.status) ? d : null;
  });
  const passo = esecuzione?.run.steps.find((s) => s.nodeId === 'chiama');
  console.log(
    `  Chiamata: ${passo?.status ?? '?'} · ${(passo?.output ?? passo?.error ?? '').slice(0, 120)}`,
  );

  // ── E la guardia contro chi chiama sé stesso ───────────────────────────
  const { workflow: ricorsivo } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'collaudo-sub-ricorsivo',
      nodes: [{ id: 'io', defId: 'logic_subworkflow', x: 0, y: 0, config: { wait: 'true' } }],
      edges: [],
    }),
  });
  await call(`/workflows/${ricorsivo.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'collaudo-sub-ricorsivo',
      nodes: [
        {
          id: 'io',
          defId: 'logic_subworkflow',
          x: 0,
          y: 0,
          config: { workflowId: ricorsivo.id, wait: 'true' },
        },
      ],
      edges: [],
    }),
  });

  const { runId: runRicorsivo } = await call(`/workflows/${ricorsivo.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ input: {} }),
  });
  const ricorsiva = await attendi(async () => {
    const d = await call(`/runs/${runRicorsivo}`);
    return ['success', 'error', 'partial'].includes(d.run.status) ? d : null;
  });
  const passoRicorsivo = ricorsiva?.run.steps.find((s) => s.nodeId === 'io');
  console.log(
    `  Auto-chiamata: ${passoRicorsivo?.status ?? '?'} · ${(passoRicorsivo?.error ?? '').slice(0, 90)}`,
  );

  console.log('');
  // L'esecuzione del figlio, ritrovata dal suo identificativo: il dispatch la
  // chiama `runId`, la lettura la chiama `id`, e leggere il campo sbagliato
  // non fallisce — restituisce `undefined`.
  const idFiglio = JSON.parse(passo?.output ?? '{}').runId;
  const figliaFinita = idFiglio ? await call(`/runs/${idFiglio}`) : null;
  console.log(`  Esecuzione del figlio: ${figliaFinita?.run.status ?? 'non ritrovata'}`);

  const esito = [
    ['la chiamata riesce', passo?.status === 'success'],
    ['il chiamante riceve l’identificativo del chiamato', Boolean(idFiglio)],
    ['e quella esecuzione esiste davvero', figliaFinita?.run.status === 'success'],
    ['chi chiama sé stesso viene fermato', passoRicorsivo?.status === 'error'],
    [
      'e il motivo lo dice',
      Boolean(passoRicorsivo?.error?.toLowerCase().includes('self-recursion')),
    ],
    // Il punto: «aspetta» aspetta. Se qualcuno tornasse alla risposta
    // immediata del dispatch, qui si vedrebbe `running` con zero passi.
    ['«aspetta» aspetta davvero', JSON.parse(passo?.output ?? '{}').status === 'success'],
    [
      'e il chiamante riceve i passi del chiamato',
      (JSON.parse(passo?.output ?? '{}').steps ?? []).length > 0,
    ],
  ];
  for (const [cosa, ok] of esito) console.log(`  ${ok ? '✓' : '✗'} ${cosa}`);

  if (esito.every(([, ok]) => ok)) {
    console.log('\nSUBWORKFLOW CONFERMATO: un workflow ne chiama un altro, e non sé stesso.');
    process.exit(0);
  }
  console.log('\nSUBWORKFLOW NON CONFERMATO.');
  process.exit(1);
}

await main();
