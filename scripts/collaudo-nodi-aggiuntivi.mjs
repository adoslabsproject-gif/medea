/**
 * Collaudo dei nodi aggiuntivi: un pacchetto `.ffnode` si installa da file e
 * il suo nodo esegue?
 *
 * È la prova che Medea non è chiusa ai 194 nodi che ha nella scatola. Il
 * pacchetto si costruisce qui, si installa attraverso la stessa strada che usa
 * l'app (base64 → `/community-nodes/install`), e poi si esegue.
 *
 * Il formato ha tre trappole, tutte trovate provando:
 *
 *  1. `manifest.id` e `nodedef.id` devono essere **uguali**, altrimenti
 *     l'installazione rifiuta con «id mismatch».
 *  2. `nodedef` vuole `color` (esadecimale) e `description`: sono
 *     obbligatori, non decorazione.
 *  3. L'esecutore gira in `isolated-vm`, che valuta uno **script**, non un
 *     modulo: `export default` esplode con «Unexpected token 'export'». Va
 *     scritto `module.exports = ...`.
 *
 * Uso: node scripts/collaudo-nodi-aggiuntivi.mjs [http://127.0.0.1:PORTA]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:39102';
const EMAIL = 'collaudo@localhost.local';
const PASSWORD = 'Collaudo-Medea-2026!';

/** Il nodo di prova. Un identificativo solo, usato ovunque. */
const NODE_ID = 'collaudo_saluto';
const VENDOR = 'collaudo';

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

/** Costruisce il pacchetto e restituisce il suo contenuto in base64. */
function buildPackage(version) {
  const dir = mkdtempSync(join(tmpdir(), 'medea-ffnode-'));
  const inside = join(dir, 'pacchetto');
  mkdirSync(inside);

  writeFileSync(
    join(inside, 'manifest.json'),
    JSON.stringify(
      {
        id: NODE_ID,
        vendor: VENDOR,
        version,
        displayName: 'Saluto di collaudo',
        description: 'Un nodo minimo per verificare che l’installazione da file funzioni.',
        license: 'MIT',
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(inside, 'nodedef.json'),
    JSON.stringify(
      {
        id: NODE_ID,
        type: 'action',
        label: 'Saluto di collaudo',
        icon: 'sparkles',
        color: '#7c5cff',
        vendor: VENDOR,
        version,
        description: 'Restituisce un saluto con il nome che gli si passa.',
        configFields: [{ key: 'nome', label: 'Nome', type: 'text', required: true }],
        outputs: ['saluto'],
      },
      null,
      2,
    ),
  );

  // CommonJS, non ESM: la sandbox valuta uno script.
  writeFileSync(
    join(inside, 'executor.js'),
    'module.exports = async function execute(config) {\n' +
      "  return { saluto: `Ciao ${config.nome || 'mondo'}` };\n" +
      '};\n',
  );

  const file = join(dir, 'collaudo.ffnode');
  execFileSync('zip', ['-q', '-r', file, '.'], { cwd: inside });
  const base64 = readFileSync(file).toString('base64');
  rmSync(dir, { recursive: true, force: true });
  return base64;
}

async function main() {
  console.log(`Collaudo dei nodi aggiuntivi su ${BASE}\n`);
  await authenticate();

  // Una versione diversa a ogni giro: reinstallare la stessa non prova niente.
  const version = `1.0.${String(Number(process.hrtime.bigint() % 900n) + 10)}`;
  console.log(`  Costruisco il pacchetto (v${version})…`);
  const base64 = buildPackage(version);

  const installed = await call('/community-nodes/install', {
    method: 'POST',
    body: JSON.stringify({ base64 }),
  });
  console.log(
    `  Installato: ${installed.vendor}/${installed.id} v${installed.version} · firma ${installed.verified ? 'riconosciuta' : 'non riconosciuta'}`,
  );

  const catalogo = await call('/nodes?package=community');
  const nodi = Array.isArray(catalogo) ? catalogo : catalogo.nodes;
  const nostro = nodi.find((n) => n.id === NODE_ID);
  console.log(`  Nel catalogo del motore: ${nostro ? nostro.label : 'ASSENTE'}`);

  const prova = await call('/workflows/test-node-ephemeral', {
    method: 'POST',
    body: JSON.stringify({
      nodeId: 'saluta',
      nodes: [{ id: 'saluta', defId: NODE_ID, config: { nome: 'Medea' } }],
      edges: [],
      triggerInput: {},
    }),
  });
  console.log(`  Eseguito: ${prova.step.status} → ${prova.step.output}`);

  await call(`/community-nodes/${VENDOR}/${NODE_ID}`, { method: 'DELETE' });
  const dopo = await call('/community-nodes/installed');
  const rimasto = dopo.nodes.some((n) => n.id === NODE_ID);
  console.log(`  Rimosso: ${rimasto ? 'NO, è ancora lì' : 'sì'}`);

  console.log('');
  const esito = [
    ['il pacchetto si installa', installed.ok === true],
    ['il nodo compare nel catalogo', Boolean(nostro)],
    ['il nodo esegue', prova.step.status === 'success'],
    ['restituisce quello che deve', prova.step.output.includes('Ciao Medea')],
    ['si disinstalla', !rimasto],
  ];
  for (const [cosa, ok] of esito) console.log(`  ${ok ? '✓' : '✗'} ${cosa}`);

  if (esito.every(([, ok]) => ok)) {
    console.log('\nNODI AGGIUNTIVI CONFERMATI: Medea non è chiusa ai suoi 194.');
    process.exit(0);
  }
  console.log('\nNODI AGGIUNTIVI NON CONFERMATI.');
  process.exit(1);
}

await main();
