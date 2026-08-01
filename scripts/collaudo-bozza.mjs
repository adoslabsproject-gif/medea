/**
 * Collaudo della bozza: provare una modifica la manda in produzione?
 *
 * Il motore tiene UNA copia per identificativo, ed è quella che lo scheduler
 * esegue. Finché premere «Esegui» ci scriveva sopra la bozza, provare una
 * modifica su un workflow attivo la mandava in produzione senza che nessuno
 * l'avesse chiesto: si cambiava un indirizzo per vedere l'effetto, e il cron
 * delle otto del mattino dopo usava quello.
 *
 * Qui si mette in scena esattamente quella sequenza:
 *
 *   1. si pubblica un workflow che dice «versione 1» e lo si attiva
 *   2. si modifica la bozza perché dica «versione 2»
 *   3. si esegue la BOZZA — come farebbe «Esegui»
 *   4. si controlla che quella PUBBLICATA dica ancora «versione 1»
 *
 * Se il quarto punto fallisce, la separazione non c'è.
 *
 * Uso: node scripts/collaudo-bozza.mjs [http://127.0.0.1:PORTA]
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

/** Un workflow che dice quale versione è. */
function documento(versione, enabled) {
  return {
    name: `collaudo-bozza-${versione}`,
    nodes: [
      { id: 'avvio', defId: 'trigger_manual', x: 0, y: 0, config: {} },
      {
        id: 'dice',
        defId: 'action_run_js',
        x: 220,
        y: 0,
        config: { code: `return { versione: '${versione}' };` },
      },
    ],
    edges: [{ from: 'avvio', to: 'dice' }],
    enabled,
  };
}

/** Cosa dice la copia che il motore ha adesso. */
function versioneDi(workflow) {
  const nodo = workflow.nodes.find((n) => n.id === 'dice');
  return /versione: '([^']+)'/.exec(nodo?.config?.code ?? '')?.[1] ?? '?';
}

async function main() {
  console.log(`Collaudo della separazione bozza/pubblicato su ${BASE}\n`);
  await authenticate();

  // 1. La versione pubblicata, attiva.
  const { workflow: pubblicato } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify(documento('uno', true)),
  });
  console.log(`  Pubblicata: ${pubblicato.id} · dice «${versioneDi(pubblicato)}»`);

  // 2-3. La bozza modificata, eseguita — come fa «Esegui» adesso: su una
  // COPIA separata, sempre spenta.
  const { workflow: bozza } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify(documento('due', false)),
  });
  await call(`/workflows/${bozza.id}/run`, { method: 'POST', body: JSON.stringify({ input: {} }) });
  console.log(`  Bozza provata: ${bozza.id} · dice «${versioneDi(bozza)}»`);

  // 4. E adesso: cosa esegue lo scheduler?
  const dopo = await call(`/workflows/${pubblicato.id}`);
  const versioneInProduzione = versioneDi(dopo.workflow);
  console.log(`  In produzione dopo la prova: «${versioneInProduzione}»`);

  const attiva = dopo.workflow.enabled === true;
  const bozzaSpenta = (await call(`/workflows/${bozza.id}`)).workflow.enabled === false;

  console.log('');
  const esito = [
    ['la copia pubblicata resta alla sua versione', versioneInProduzione === 'uno'],
    ['la copia pubblicata resta attiva', attiva],
    ['la copia di prova resta spenta', bozzaSpenta],
    ['sono due copie distinte', pubblicato.id !== bozza.id],
  ];
  for (const [cosa, ok] of esito) console.log(`  ${ok ? '✓' : '✗'} ${cosa}`);

  if (esito.every(([, ok]) => ok)) {
    console.log('\nSEPARAZIONE CONFERMATA: provare non manda in produzione.');
    process.exit(0);
  }
  console.log('\nSEPARAZIONE NON CONFERMATA.');
  process.exit(1);
}

await main();
