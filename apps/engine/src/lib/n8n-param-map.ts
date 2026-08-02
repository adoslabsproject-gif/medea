/**
 * Param-mapper n8n → config FlowForge, per-tipo di nodo.
 *
 * L'import n8n copiava i `parameters` RAW nel config: nomi/forma n8n ≠ schema config
 * FlowForge → nodo creato ma non funzionante. Qui traduciamo i parametri ai campi
 * config REALI del nodo target (verificati nelle definition stdlib).
 *
 * Filosofia onesta (no magia finta):
 *   - dove la mappatura è pulita (HTTP url/method/body, Code, Webhook, Cron) → mappa.
 *   - dove la struttura n8n è complessa e divergente (Set assignments, IF/Switch
 *     conditions) → passthrough dei param RAW + WARNING esplicito "rivedi a mano".
 *   - auth/credenziali/header collection n8n → non mappati: warning (vanno rifatti).
 *
 * I VALORI restano in sintassi-espressione n8n: il transpiler (n8n-expression.ts) li
 * converte DOPO, al confine. Qui solo i NOMI/forma dei campi.
 */

import { mapN8nIfConditions } from './n8n-condition-map.js';

type Raw = Record<string, unknown>;
export interface ParamMapResult {
  config: Record<string, string>;
  warnings: string[];
}

function s(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}

/** Default: preserva i param RAW (per review manuale), nessuna traduzione. */
function passthrough(p: Raw): ParamMapResult {
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) config[k] = s(v);
  return { config, warnings: [] };
}

/** Passthrough + un warning fisso (per i tipi a struttura complessa). */
function passthroughWarn(message: string): (p: Raw) => ParamMapResult {
  return (p) => ({ config: passthrough(p).config, warnings: [message] });
}

/** HTTP Request → action_http (method/url/body mappati; auth/header → warning). */
function mapHttp(p: Raw): ParamMapResult {
  const warnings: string[] = [];
  const config: Record<string, string> = {};
  config.method = s(p.method ?? p.requestMethod ?? 'GET').toUpperCase() || 'GET';
  config.url = s(p.url ?? '');
  const body = p.jsonBody ?? p.body ?? p.bodyParametersJson;
  if (body !== undefined && body !== '') {
    config.bodyType = 'json';
    config.body = s(body);
  }
  if (p.authentication !== undefined && p.authentication !== 'none' && p.authentication !== '') {
    warnings.push('autenticazione HTTP n8n non mappata — riconfigura authMode + credenziali');
  }
  if (
    p.headerParameters !== undefined ||
    p.sendHeaders !== undefined ||
    p.headerParametersJson !== undefined
  ) {
    warnings.push('header HTTP n8n non mappati automaticamente — compila headersJson');
  }
  return { config, warnings };
}

/** Code/Function (JS) → action_run_js. */
function mapRunJs(p: Raw): ParamMapResult {
  const code = s(p.jsCode ?? p.functionCode ?? p.code ?? '');
  if (!code) return { config: {}, warnings: [] };
  return {
    config: { code },
    warnings: [
      'il codice n8n usa $input.all()/items/return items; FlowForge espone `input` (JSON del nodo precedente) e si emette con `return <valore>` — adatta',
    ],
  };
}

/** Code (Python) → action_run_python. */
function mapRunPython(p: Raw): ParamMapResult {
  const code = s(p.pythonCode ?? p.code ?? '');
  if (!code) return { config: {}, warnings: [] };
  return {
    config: { code },
    warnings: [
      "adatta il codice: FlowForge espone `input`; l'output va su stdout come JSON via print(...)",
    ],
  };
}

/** Webhook → trigger_webhook (method/path). */
function mapWebhook(p: Raw): ParamMapResult {
  const config: Record<string, string> = {};
  config.method = s(p.httpMethod ?? 'POST').toUpperCase() || 'POST';
  if (p.path !== undefined && p.path !== '') config.customPath = s(p.path);
  return { config, warnings: [] };
}

/** Cron/Schedule → trigger_cron (estrae cronExpression; rule/interval → warning). */
function mapCron(p: Raw): ParamMapResult {
  const warnings: string[] = [];
  let cron = typeof p.cronExpression === 'string' ? p.cronExpression : undefined;
  if (!cron) {
    const tt = p.triggerTimes as { item?: { cronExpression?: unknown }[] } | undefined;
    const found = tt?.item?.find((i) => typeof i.cronExpression === 'string');
    if (found) cron = found.cronExpression as string;
  }
  const config: Record<string, string> = {};
  if (cron) {
    config.cronExpression = cron;
  } else {
    config.cronExpression = '0 * * * *';
    warnings.push(
      'lo schedule n8n (rule/interval) non è un cron diretto — impostato default "ogni ora", da rivedere',
    );
  }
  return { config, warnings };
}

const MAPPERS: Record<string, (p: Raw) => ParamMapResult> = {
  action_http: mapHttp,
  action_run_js: mapRunJs,
  action_run_python: mapRunPython,
  trigger_webhook: mapWebhook,
  trigger_cron: mapCron,
  // IF: condizioni n8n (v1/v2) → conditionRules FlowForge (mapping REALE).
  logic_if: (p) => mapN8nIfConditions(p),
  // Strutture ancora complesse: passthrough RAW + warning onesto (prossimi increment).
  logic_transform: passthroughWarn(
    'Set/Edit Fields: la struttura assegnazioni n8n differisce dal nodo Transform FlowForge — rivedi i campi',
  ),
  logic_switch: passthroughWarn('Switch: rivedi i casi/regole del nodo (struttura n8n diversa)'),
};

/** Mappa i parametri n8n al config FlowForge per il defId target. */
export function mapN8nParams(defId: string, params: Raw): ParamMapResult {
  return (MAPPERS[defId] ?? passthrough)(params);
}
