/**
 * Regole sulla configurazione dei singoli nodi.
 *
 * Sono errori che si vedono solo sapendo come quel nodo si comporta davvero:
 * uno switch che confronta stringhe non può valutare `score < 90`, un nodo
 * JavaScript non può eseguire Python, un modello ritirato dal fornitore non
 * risponde più.
 */

import { detectCodeLanguage, LANG_FOR_CODE_NODE } from './code-lang';
import { asStr, safeParseJson } from './graph';
import type { QualityGateInput, QualityIssue } from './types';

function readCases(raw: unknown): unknown {
  return typeof raw === 'string' ? safeParseJson(raw) : raw;
}

/** Uno switch senza ramo di default: ciò che non corrisponde a nessun caso
 *  sparisce senza dire niente. */
export function checkSwitchDefault(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    if (node.defId !== 'logic_switch') continue;
    const fallback = node.config.defaultCase ?? node.config.default;
    if (fallback !== undefined && fallback !== null && fallback !== '') continue;
    const cases = readCases(node.config.cases);
    if (!cases || typeof cases !== 'object') continue;
    issues.push({
      severity: 'medium',
      code: 'SWITCH_NO_DEFAULT',
      nodeId: node.id,
      field: 'defaultCase',
      message: `Lo switch "${node.id}" ha ${Object.keys(cases).length} casi ma nessun ramo di default: tutto ciò che non corrisponde a un caso viene perso.`,
    });
  }
  return issues;
}

const OPERATOR_IN_CASE_RE = /(<|>|<=|>=|==|===|!=|!==|&&|\|\||\(|\))/;

/**
 * Casi dello switch scritti come espressioni. Lo switch confronta stringhe e
 * basta: una chiave come `score < 90` non corrisponderà mai a nulla e il
 * flusso finirà sempre sul ramo di scarto.
 */
export function checkSwitchInvalidCaseKey(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    if (node.defId !== 'logic_switch') continue;
    const cases = readCases(node.config.cases);
    if (!cases || typeof cases !== 'object') continue;

    // Due forme ammesse: { "chiave": "ramo" } oppure [{ case, output }].
    const keys: string[] = [];
    if (Array.isArray(cases)) {
      for (const c of cases) {
        if (c && typeof c === 'object') {
          const entry = c as Record<string, unknown>;
          const k = entry.case ?? entry.match;
          if (typeof k === 'string') keys.push(k);
        }
      }
    } else {
      keys.push(...Object.keys(cases));
    }

    const invalid = keys.filter((k) => OPERATOR_IN_CASE_RE.test(k));
    if (invalid.length === 0) continue;
    const shown = invalid
      .slice(0, 2)
      .map((k) => `"${k}"`)
      .join(', ');
    issues.push({
      severity: 'critical',
      code: 'SWITCH_INVALID_CASE_KEY',
      nodeId: node.id,
      field: 'cases',
      message: `Lo switch "${node.id}" ha casi scritti come espressioni (${shown}). Lo switch confronta stringhe esatte, non valuta condizioni: il flusso finirebbe sempre sul ramo di scarto. Usa "logic_if" per le condizioni, oppure calcola prima l'etichetta con un classificatore.`,
    });
  }
  return issues;
}

/** Codice scritto nel linguaggio sbagliato per il nodo che lo esegue. */
export function checkCodeNodeLangMismatch(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const human = (l: string): string => (l === 'python' ? 'Python' : 'JavaScript');
  for (const node of input.nodes) {
    const expected = LANG_FOR_CODE_NODE.get(node.defId);
    if (!expected) continue;
    const code = asStr(node.config.code);
    if (code.trim().length === 0) continue;
    const detected = detectCodeLanguage(code);
    if (detected === 'ambiguous' || detected === expected) continue;
    const right = detected === 'python' ? 'action_run_python' : 'action_run_js';
    issues.push({
      severity: 'critical',
      code: 'CODE_NODE_LANG_MISMATCH',
      nodeId: node.id,
      field: 'code',
      message: `Il nodo "${node.id}" (${node.defId}) contiene codice ${human(detected)} ma esegue ${human(expected)}: fallirebbe subito. Usa "${right}" per questo codice, oppure riscrivilo in ${human(expected)}.`,
    });
  }
  return issues;
}

/** Modelli ritirati dai fornitori. Aggiornare questa lista è una riga. */
const OBSOLETE_MODELS_BY_PROVIDER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'openai',
    new Set([
      'gpt-3.5-turbo-0301',
      'gpt-3.5-turbo-0613',
      'gpt-3.5-turbo-16k-0613',
      'gpt-4-0314',
      'gpt-4-0613',
      'gpt-4-32k-0314',
      'gpt-4-32k-0613',
      'text-davinci-003',
      'text-davinci-002',
      'code-davinci-002',
    ]),
  ],
  [
    'anthropic',
    new Set([
      'claude-instant-1',
      'claude-instant-1.2',
      'claude-1',
      'claude-1.3',
      'claude-2',
      'claude-2.0',
      'claude-2.1',
      'claude-3-haiku-20240307',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
    ]),
  ],
  ['gemini', new Set(['gemini-pro', 'gemini-pro-vision', 'gemini-1.0-pro'])],
  ['mistral', new Set(['mistral-tiny', 'mistral-small', 'mistral-medium'])],
]);

export function checkObsoleteModel(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    if (!node.defId.startsWith('agent_')) continue;
    const provider = asStr(node.config.provider).toLowerCase();
    const model = asStr(node.config.model).trim();
    if (!provider || !model) continue;
    if (!OBSOLETE_MODELS_BY_PROVIDER.get(provider)?.has(model)) continue;
    issues.push({
      severity: 'medium',
      code: 'OBSOLETE_MODEL',
      nodeId: node.id,
      field: 'model',
      message: `Il nodo "${node.id}" usa il modello "${model}" di ${provider}, che il fornitore ha ritirato. Lascia il campo vuoto per usare il modello predefinito, oppure indicane uno ancora supportato.`,
    });
  }
  return issues;
}
