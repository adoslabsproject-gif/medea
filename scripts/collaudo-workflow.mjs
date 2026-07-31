/**
 * Collaudo del runtime dei workflow.
 *
 * Non verifica che il codice compili: verifica che i nodi **eseguano**. Ogni
 * caso è un workflow vero, mandato al runtime locale e fatto girare, e il
 * controllo è sul risultato che produce.
 *
 * Copre una famiglia di nodi per volta — codice, trasformazioni, logica,
 * cicli, HTTP, database — perché è così che si scopre quale famiglia si è
 * rotta, invece di sapere solo che «qualcosa non va».
 *
 * Uso: node scripts/collaudo-workflow.mjs [http://127.0.0.1:PORTA]
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
  try {
    ({ token } = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }));
  } catch {
    await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: 'Collaudo' }),
    });
    ({ token } = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }));
  }
}

/** Manda il workflow, lo esegue, e aspetta che finisca. */
async function run(name, nodes, edges, input = {}) {
  const { workflow } = await call('/workflows', {
    method: 'POST',
    body: JSON.stringify({ name, nodes, edges }),
  });
  const { runId } = await call(`/workflows/${workflow.id}/run`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    const { run: detail } = await call(`/runs/${runId}`);
    if (!['running', 'pending'].includes(detail.status)) return detail;
    if (Date.now() > deadline) throw new Error('esecuzione troppo lunga');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const node = (id, defId, config = {}) => ({ id, defId, x: 0, y: 0, config });
const edge = (from, to, fromPort) => ({ from, to, ...(fromPort ? { fromPort } : {}) });

/** L'output di un nodo, già letto dal JSON in cui il runtime lo incarta. */
function outputOf(detail, nodeId) {
  const step = detail.steps.find((s) => s.nodeId === nodeId);
  if (!step?.output) return undefined;
  try {
    return JSON.parse(step.output);
  } catch {
    return step.output;
  }
}

const CASES = [
  {
    name: 'JavaScript nella sandbox',
    why: 'il nodo codice è il più difficile: gira in isolated-vm, fuori dal processo',
    async check() {
      const detail = await run(
        'collaudo-js',
        [
          node('avvio', 'trigger_manual'),
          node('calcola', 'action_run_js', {
            code: 'return { somma: [1,2,3,4].reduce((a,b)=>a+b, 0) };',
          }),
        ],
        [edge('avvio', 'calcola')],
      );
      const out = outputOf(detail, 'calcola');
      return { ok: detail.status === 'success' && out?.result?.somma === 10, detail, out };
    },
  },
  {
    name: 'Espressioni fra nodi',
    why: 'senza, un nodo non può leggere quello che ha prodotto il precedente',
    async check() {
      const detail = await run(
        'collaudo-espressioni',
        [
          node('avvio', 'trigger_manual'),
          node('primo', 'action_run_js', { code: 'return { valore: 21 };' }),
          node('secondo', 'action_run_js', {
            code: 'return { doppio: {{$node.primo.json.result.valore}} * 2 };',
          }),
        ],
        [edge('avvio', 'primo'), edge('primo', 'secondo')],
      );
      const out = outputOf(detail, 'secondo');
      return { ok: detail.status === 'success' && out?.result?.doppio === 42, detail, out };
    },
  },
  {
    name: 'Condizione con due rami',
    why: 'un workflow che esegue entrambe le strade manda due email invece di una',
    async check() {
      const detail = await run(
        'collaudo-if',
        [
          node('avvio', 'trigger_manual'),
          node('valore', 'action_run_js', { code: 'return { n: 100 };' }),
          node('controlla', 'logic_if', {
            conditionRules: JSON.stringify({
              combinator: 'AND',
              rules: [
                {
                  left: '{{$node.valore.json.result.n}}',
                  op: 'gt',
                  right: '50',
                  type: 'number',
                },
              ],
            }),
          }),
          node('alto', 'action_run_js', { code: "return { ramo: 'alto' };" }),
          node('basso', 'action_run_js', { code: "return { ramo: 'basso' };" }),
        ],
        [
          edge('avvio', 'valore'),
          edge('valore', 'controlla'),
          edge('controlla', 'alto', 'true'),
          edge('controlla', 'basso', 'false'),
        ],
      );
      const preso = detail.steps.find((s) => s.nodeId === 'alto');
      const scartato = detail.steps.find((s) => s.nodeId === 'basso');
      return {
        ok: preso?.status === 'success' && scartato?.status !== 'success',
        detail,
        out: { preso: preso?.status, scartato: scartato?.status ?? 'non eseguito' },
      };
    },
  },
  {
    name: 'Chiamata HTTP',
    why: 'è il nodo più usato di tutti, e tocca la rete davvero',
    async check() {
      const detail = await run(
        'collaudo-http',
        [
          node('avvio', 'trigger_manual'),
          node('chiama', 'action_http', {
            url: 'https://example.com',
            method: 'GET',
            timeoutMs: '15000',
          }),
        ],
        [edge('avvio', 'chiama')],
      );
      const out = outputOf(detail, 'chiama');
      return { ok: detail.status === 'success' && out?.status === 200, detail, out };
    },
  },
  {
    name: 'Un nodo che fallisce ferma il flusso',
    why: 'un errore ignorato è peggio di un errore: il workflow continua su dati sbagliati',
    async check() {
      const detail = await run(
        'collaudo-errore',
        [
          node('avvio', 'trigger_manual'),
          node('rompi', 'action_run_js', { code: 'throw new Error("errore voluto");' }),
          node('dopo', 'action_run_js', { code: 'return { arrivato: true };' }),
        ],
        [edge('avvio', 'rompi'), edge('rompi', 'dopo')],
      );
      const dopo = detail.steps.find((s) => s.nodeId === 'dopo');
      return {
        ok: detail.errorCount > 0 && dopo?.status !== 'success',
        detail,
        out: { errori: detail.errorCount, dopo: dopo?.status ?? 'non eseguito' },
      };
    },
  },
];

async function main() {
  console.log(`Collaudo del runtime su ${BASE}\n`);
  await authenticate();

  let passed = 0;
  for (const testCase of CASES) {
    process.stdout.write(`  ${testCase.name} … `);
    try {
      const { ok, detail, out } = await testCase.check();
      if (ok) {
        passed++;
        console.log(`OK (${detail.totalDurationMs} ms)`);
      } else {
        console.log('FALLITO');
        console.log(`      perché conta: ${testCase.why}`);
        console.log(`      stato: ${detail.status}, risultato: ${JSON.stringify(out)}`);
        const rotto = detail.steps.find((s) => s.status === 'error');
        if (rotto) console.log(`      errore su "${rotto.nodeId}": ${rotto.error}`);
      }
    } catch (e) {
      console.log(`FALLITO — ${e.message}`);
      console.log(`      perché conta: ${testCase.why}`);
    }
  }

  console.log(`\n${passed}/${CASES.length} casi superati`);
  process.exit(passed === CASES.length ? 0 : 1);
}

await main();
