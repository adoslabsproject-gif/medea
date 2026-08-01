/**
 * Impacchetta il motore dei workflow dentro Medea.
 *
 * Il motore è il runtime di FlowForge: gira come processo figlio e sa
 * eseguire tutti i nodi. Finché resta un percorso sulla macchina di chi
 * sviluppa, Medea «funziona» solo lì — che è un altro modo di dire che non
 * funziona. Questo script produce la copia che viaggia con l'app.
 *
 * Cosa serve davvero, scoperto provando e non leggendo:
 *
 *  - `dist/` con `main.js` e i suoi fratelli;
 *  - le dipendenze di produzione **installate**, non impacchettate: i moduli
 *    nativi (`better-sqlite3`, `isolated-vm`, `argon2`, `duckdb`) non si
 *    possono unire in un file solo;
 *  - `typescript`, che è dichiarato come dipendenza di sviluppo ma il runtime
 *    lo carica all'avvio per compilare i nodi personalizzati. Senza, muore
 *    subito con «Cannot find module 'typescript'»;
 *  - `@duckdb/node-api`, che pesa un'esagerazione (107 MB) e non serve a
 *    nessun nodo del catalogo — ma è importato all'avvio, quindi toglierlo
 *    significa un runtime che non parte. Provato.
 *  - un `node` accanto al resto, così l'app non dipende da quello di sistema.
 *
 * Uso:
 *   FLOWFORGE_RUNTIME_SRC=/percorso/a/apps/flowforge-runtime \
 *     node scripts/package-runtime.mjs
 *
 * Il risultato finisce in `apps/desktop/src-tauri/resources/runtime/` e
 * **non** si committa: sono centinaia di MB, si rigenerano.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'apps/desktop/src-tauri/resources/runtime');

/** Il nome del pacchetto nel workspace di FlowForge. */
const PACKAGE = '@flowforge/runtime';

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/** La cartella del runtime di FlowForge, da cui si prende tutto. */
function sourceDir() {
  const declared = process.env.FLOWFORGE_RUNTIME_SRC;
  if (!declared) {
    fail(
      'manca FLOWFORGE_RUNTIME_SRC: indica la cartella apps/flowforge-runtime del repo di FlowForge.\n' +
        '  Un percorso scritto qui dentro funzionerebbe su una macchina sola.',
    );
  }
  const path = resolve(declared);
  if (!existsSync(join(path, 'package.json'))) fail(`in «${path}» non c'è un package.json`);
  return path;
}

/** La radice del workspace: `pnpm deploy` si lancia da lì. */
function workspaceRoot(from) {
  let current = from;
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) fail(`nessun pnpm-workspace.yaml sopra «${from}»`);
    current = parent;
  }
}

/** Quanto pesa una cartella, in MB. Serve solo a dirlo a chi guarda. */
function sizeMb(path) {
  const out = execFileSync('du', ['-sm', path], { encoding: 'utf8' });
  return Number.parseInt(out.split('\t')[0] ?? '0', 10);
}

/** Toglie ogni `node_modules/**\/.bin`, a qualunque profondità. */
function dropBinDirs(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === '.bin') rmSync(path, { recursive: true, force: true });
      else stack.push(path);
    }
  }
}

/**
 * Toglie il peso morto: le mappe dei sorgenti, e i collegamenti che non
 * portano da nessuna parte.
 *
 * I collegamenti rotti arrivano da `node_modules/.bin`, dove pnpm lascia
 * scorciatoie verso comandi di sviluppo che nel pacchetto di produzione non
 * esistono. A eseguire non servono, ma Tauri li incontra mentre raccoglie le
 * risorse e si ferma: «resource path doesn't exist».
 */
function prune(root) {
  // NB: le dichiarazioni `.d.ts` NON si toccano — la libreria `typescript`
  // è fatta di quelle, e senza il runtime non compila i nodi personalizzati.
  const stack = [root];
  let removed = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() && !existsSync(path)) {
        rmSync(path, { force: true });
        removed++;
      } else if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.name.endsWith('.map')) {
        rmSync(path, { force: true });
        removed++;
      }
    }
  }
  return removed;
}

/** Verifica che quello che abbiamo impacchettato parta davvero. */
async function smoke(target) {
  const port = 39300 + Number(process.hrtime.bigint() % 200n);
  const data = mkdtempSync(join(tmpdir(), 'medea-runtime-smoke-'));
  const node = join(target, 'node');
  const child = spawn(node, [join(target, 'dist/main.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: data, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (b) => (log += b.toString()));
  child.stderr.on('data', (b) => (log += b.toString()));

  const deadline = Date.now() + 45_000;
  let alive = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (response.ok) {
        alive = true;
        break;
      }
    } catch {
      // Non ha ancora aperto la porta: si riprova.
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  child.kill();
  rmSync(data, { recursive: true, force: true });

  if (!alive) {
    const missing = /Cannot find module '([^']+)'/.exec(log);
    fail(
      missing
        ? `il runtime impacchettato non parte: manca il modulo «${missing[1]}».\n` +
            '  Aggiungilo a EXTRA_MODULES in questo script.'
        : `il runtime impacchettato non parte. Ultime righe:\n${log.slice(-1200)}`,
    );
  }
}

/** Moduli che il runtime carica all'avvio ma non dichiara fra le dipendenze
 *  di produzione. Ognuno di questi è costato un avvio fallito. */
const EXTRA_MODULES = ['typescript'];

async function main() {
  const source = sourceDir();
  const workspace = workspaceRoot(source);

  if (!existsSync(join(source, 'dist/main.js'))) {
    fail(`in «${source}» non c'è dist/main.js: compila il runtime prima (pnpm build).`);
  }

  console.log('Impacchetto il motore dei workflow.\n');
  const staging = mkdtempSync(join(tmpdir(), 'medea-runtime-'));

  console.log('  Installo le dipendenze di produzione…');
  // `node-linker=hoisted`: senza, pnpm scrive un albero di collegamenti che
  // puntano al suo deposito. Copiarlo altrove lascia collegamenti rotti, e il
  // runtime muore al primo `import` con «Cannot find package». Provato.
  run(
    'pnpm',
    [
      `--filter=${PACKAGE}`,
      'deploy',
      '--prod',
      '--legacy',
      '--config.node-linker=hoisted',
      staging,
    ],
    workspace,
  );

  console.log('  Aggiungo i moduli che il runtime carica ma non dichiara…');
  for (const name of EXTRA_MODULES) {
    const found = [join(source, 'node_modules', name), join(workspace, 'node_modules', name)].find(
      (p) => existsSync(p),
    );
    if (!found) fail(`non trovo il modulo «${name}» da nessuna parte nel workspace`);
    // `dereference`: i collegamenti di pnpm puntano a uno store che non
    // viaggia con l'app.
    cpSync(found, join(staging, 'node_modules', name), { recursive: true, dereference: true });
  }

  // Le cartelle `.bin` sono scorciatoie a comandi da riga: il runtime non ne
  // lancia nessuno, e i loro collegamenti puntano alla cartella temporanea di
  // questo script — che fra un attimo non esisterà più. Ce n'è una in cima e
  // una dentro parecchi pacchetti annidati: vanno tolte tutte, altrimenti
  // Tauri si ferma sul primo collegamento che non porta da nessuna parte.
  console.log('  Tolgo le scorciatoie ai comandi…');
  dropBinDirs(join(staging, 'node_modules'));

  console.log('  Tolgo il peso morto…');
  const removed = prune(join(staging, 'node_modules')) + prune(join(staging, 'dist'));
  console.log(`    ${String(removed)} mappe dei sorgenti rimosse.`);

  console.log('  Copio l’eseguibile Node…');
  cpSync(process.execPath, join(staging, 'node'), { dereference: true });

  // Solo quello che serve a eseguire: i sorgenti e la configurazione di
  // sviluppo del runtime non c'entrano niente con l'app installata.
  console.log('  Metto insieme il pacchetto…');
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  for (const name of ['dist', 'node_modules', 'package.json', 'node']) {
    const from = join(staging, name);
    if (existsSync(from)) {
      cpSync(from, join(TARGET, name), { recursive: true, dereference: true });
    }
  }
  // `main.js` resta dentro `dist/`: importa i suoi fratelli con percorsi
  // relativi, e spostarlo di una cartella li spezzerebbe tutti.
  // 0755 e non «+x»: il Node di sistema è di sola lettura, e una copia che
  // resta tale non si lascia sovrascrivere alla costruzione successiva —
  // Tauri si ferma con «Permission denied» mentre raccoglie le risorse.
  if (existsSync(join(TARGET, 'node'))) {
    chmodSync(join(TARGET, 'node'), 0o755);
  }

  rmSync(staging, { recursive: true, force: true });

  console.log('\n  Provo che parta davvero…');
  await smoke(TARGET);

  const mb = sizeMb(TARGET);
  console.log(`\n✓ Motore impacchettato in ${TARGET} (${String(mb)} MB).`);
  console.log('  Non committarlo: si rigenera con questo script.\n');
}

await main();
