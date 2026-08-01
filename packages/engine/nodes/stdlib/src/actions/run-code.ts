/**
 * action_run_python + action_run_js — code execution nodes.
 *
 * Python: delegato al microservizio code-runner (Docker sandbox, port 5003,
 * --network=none --memory=512m --cpus=1.0 --pids-limit=50 --read-only).
 *
 * JavaScript: in-process via isolated-vm (no Docker overhead, <5ms latency,
 * memory limit + timeout). Adatto a data transformation / business logic;
 * per task lunghi/CPU-intensive usa Python.
 *
 * Entrambi expose `input` (output del nodo precedente), `vars` (workflow
 * variables) e `ctx` (run metadata) come variabili globali nello script.
 */
import type { NodeModule } from '../types.js';

export const runPythonNode: NodeModule = {
  def: {
    id: 'action_run_python',
    type: 'action',
    label: 'Run Python',
    icon: 'terminal',
    color: '#3776ab',
    description:
      'Esegue codice Python in sandbox Docker isolata (memoria 512MB, CPU 1 core, no privileges, read-only FS). ' +
      'Libreria stdlib disponibile: matplotlib/numpy/pandas/scipy/plotly/pillow/sympy/openpyxl/tabulate + requests/httpx (quando allowNetwork=true). ' +
      'Output: { stdout, stderr, exitCode, durationMs, files[] (grafici/CSV salvati in output/ ritornati base64) }. ' +
      'Timeout configurabile (max 120s). Input/ctx esposti come dict Python via env var FLOWFORGE_INPUT.\n\n' +
      'Network policy:\n' +
      '  • allowNetwork=false (default, raccomandato) → ZERO egress, sicurezza massima. Per chiamate HTTP, usa action_http_request come step separato (più ergonomico + audit nativo).\n' +
      '  • allowNetwork=true (opt-in) → egress Internet abilitato MA con SSRF block: ' +
      'cloud metadata 169.254.169.254 + RFC1918 (10/8, 172.16/12, 192.168/16) + loopback + Docker internal BLOCCATI a livello iptables. ' +
      'Audit log scrive ogni esecuzione con allowNetwork=true. Quota: 10 esec/min per tenant.\n\n' +
      'Use case: data analysis su CSV, generazione grafici matplotlib per report, ' +
      'calcoli statistici/finanziari complessi, ML inference one-shot, manipolazione immagini PIL, ' +
      'API HTTP custom non coperte dai 216 nodi stdlib (allowNetwork=true), conversioni formati custom.',
    configFields: [
      {
        key: 'code',
        label: 'Codice Python',
        type: 'code',
        required: true,
        defaultValue:
          'import json, os\n' +
          '\n' +
          'data = json.loads(os.environ.get("FLOWFORGE_INPUT", "{}"))\n' +
          'print({"received_keys": list(data.keys()), "count": len(data)})\n',
        help:
          'Codice Python. Input del nodo precedente disponibile in env var FLOWFORGE_INPUT (JSON string). ' +
          'Output stdout viene catturato e parsato come JSON se possibile, altrimenti tornato come stringa. ' +
          'Per output file (grafici/CSV) salva in cartella output/. Esempio: plt.savefig("output/chart.png"). ' +
          'Con allowNetwork=true: import requests; r=requests.get("https://api.esempio.it/x", timeout=10); print(r.json()).',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '30000',
        help: 'Tempo massimo esecuzione. Min 5000, max 120000. Default 30s.',
      },
      {
        key: 'parseStdoutJson',
        label: 'Parse stdout come JSON',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'Se on, prova a parsare stdout come JSON e ritorna l\'oggetto strutturato. ' +
          'Se off o parsing fail, ritorna stdout come stringa.',
      },
      {
        key: 'allowNetwork',
        label: 'Abilita egress Internet (HTTP outbound)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          'OFF (default, raccomandato): nessun egress, sandbox massimamente isolata. ' +
          'ON (opt-in): il codice può chiamare API HTTP esterne (requests/httpx). ' +
          'SSRF block automatico verso cloud metadata (169.254.169.254) + RFC1918 + loopback + reti Docker interne. ' +
          'Ogni esecuzione con ON viene auditata nel log dedicato code-runner. ' +
          'Per task production-grade preferisci action_http_request (più ergonomico + circuit breaker per host).',
      },
    ],
    // n8n-speak: "code node"/"function" devono trovare questo nodo (bug 2026-06-12).
    searchAliases: ['code', 'function', 'script'],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

export const runJsNode: NodeModule = {
  def: {
    id: 'action_run_js',
    type: 'action',
    label: 'Run JavaScript',
    icon: 'code-2',
    color: '#f7df1e',
    description:
      'Esecutore enterprise di codice JavaScript custom in sandbox isolated-vm in-process — la primitiva di ' +
      'escape hatch per qualsiasi trasformazione di business logic NON coperta dai nodi specifici stdlib o ' +
      'logic_transform. Usa isolated-vm (lib battle-tested usata in produzione da Cloudflare Workers, Discord ' +
      'bot eval, Replit, Algolia per allow user code execution) che fornisce isolation a livello V8 (process-' +
      'level VM con context separato) — il codice user-provided NON può vedere né interferire con il main ' +
      'runtime process del tenant, evitando classic Node.js eval vulnerabilities (process.exit, fs.access, ' +
      'require di moduli arbitrari come "child_process"). ' +
      'Sandboxing rigoroso multi-livello: NO accesso al filesystem (fs module assente), NO accesso di rete ' +
      '(fetch/http/https assenti), NO require/import di moduli (limitato strict alla standard JavaScript ' +
      'std: Math, JSON, Array, Object, Date, String, RegExp, Number, Map, Set, Promise — il subset safe-by-' +
      'construction); cap di memoria configurable (default 128MB, max 512MB per workflow heavy-compute); ' +
      'timeout configurable (default 5s, max 30s per evitare workflow stuck su infinite loop bug); deep ' +
      'stack depth cap a 1000 frame per protezione recursion-bomb. ' +
      'Performance enterprise: latenza tipica < 5ms per script piccoli (overhead di context entry/exit + ' +
      'snapshot creation è minimo), throughput sustained 1000+ exec/sec single-thread su CPU moderno — ' +
      'pattern OK per high-volume workflow batch dove ogni iter richiede un piccolo bit of custom JS. ' +
      'Variabili globali disponibili nel script: input (output JSON del nodo precedente — la fonte primaria ' +
      'di dati da processare), vars (workflow variables persistenti — ricordo cross-step), ctx (run metadata ' +
      'come runId, tenantId, workflowId, currentTime per timestamp embedding). ' +
      'Output: il valore return-ato dallo script diventa l\'output del nodo (deve essere JSON-serializable — ' +
      'no functions, no circular references, no Symbol — il check è automatic e fail con error semantic ' +
      'esplicito se viola la regola). ' +
      'Use case: trasformazione dati custom non coperta da logic_transform (es. complex map+filter+reduce ' +
      'multi-pass su array nested); calcoli business logic specifici del cliente (es. provvigione tier-based ' +
      'con scaglioni di importo + bonus YoY + override regola country); validation custom multi-field con ' +
      'rule complex (es. "if amount > 1000 AND country != billing_country AND timestamp < user.created_at + ' +
      '7days → fraud_signal"); mapping/reshape input prima di chiamata API downstream con format esotic non ' +
      'mappabile dichiarativamente; generazione di id deterministici via hash semplice (sha256(email + ' +
      'company)); compute di statistiche aggregate custom (median, percentiles, weighted average con peso ' +
      'configurable); algoritmi proprietari del cliente (lead scoring custom, churn risk score, NPS adjusted) ' +
      'che NON vuole esporre come logica in template visuale ma come black-box pura function.',
    configFields: [
      {
        key: 'code',
        label: 'Codice JavaScript',
        type: 'code',
        required: true,
        defaultValue:
          '// input = output del nodo precedente\n' +
          '// vars = workflow variables\n' +
          '// ctx = { tenantId, runId, nodeId }\n' +
          '\n' +
          'const items = input.items || [];\n' +
          'const total = items.reduce((s, x) => s + (x.amount || 0), 0);\n' +
          'return { total, count: items.length };\n',
        help:
          'Codice JS. Usa "return <value>" per emettere output (JSON-serializable). ' +
          'Strict mode. No require/import/fetch/process/eval. ' +
          'Per data transformation pattern n8n-compat usa logic_transform (più ergonomico).',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '5000',
        help: 'Tempo massimo esecuzione. Min 100, max 30000. Default 5s.',
      },
      {
        key: 'memoryLimitMb',
        label: 'Memory limit (MB)',
        type: 'number',
        required: false,
        defaultValue: '128',
        help: 'Limite memoria isolated-vm. Min 16, max 512. Default 128MB.',
      },
    ],
    // n8n-speak: "code node"/"function" devono trovare questo nodo (bug 2026-06-12).
    searchAliases: ['code', 'function', 'script'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
