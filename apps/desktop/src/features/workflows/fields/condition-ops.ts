/**
 * Gli operatori delle condizioni, per tipo di confronto.
 *
 * Su un numero non ha senso «contiene», su una stringa non ha senso «≥».
 * Mostrare solo gli operatori che valgono per il tipo scelto è la differenza
 * fra un campo che aiuta e uno che lascia sbagliare.
 *
 * Sono quelli dell'editor originale, con le stesse etichette: una condizione
 * scritta qui viene valutata dal motore là.
 */

export type RuleType = 'string' | 'number' | 'date' | 'boolean' | 'any';

export interface Rule {
  left: string;
  op: string;
  right?: string;
  rightMax?: string;
  type: RuleType;
  caseSensitive?: boolean;
}

export interface Ruleset {
  combinator: 'AND' | 'OR';
  rules: Rule[];
}

export const OPS_BY_TYPE: Record<RuleType, { value: string; label: string }[]> = {
  string: [
    { value: 'equals', label: 'è uguale a' },
    { value: 'not-equals', label: 'è diverso da' },
    { value: 'contains', label: 'contiene' },
    { value: 'not-contains', label: 'non contiene' },
    { value: 'starts-with', label: 'inizia con' },
    { value: 'ends-with', label: 'finisce con' },
    { value: 'matches-regex', label: 'corrisponde a regex' },
    { value: 'is-empty', label: 'è vuoto' },
    { value: 'is-not-empty', label: 'non è vuoto' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'ne', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'between', label: 'tra (min, max)' },
  ],
  date: [
    { value: 'before', label: 'prima di' },
    { value: 'after', label: 'dopo' },
    { value: 'equals', label: 'è uguale a' },
  ],
  boolean: [
    { value: 'is-true', label: 'è vero' },
    { value: 'is-false', label: 'è falso' },
  ],
  any: [
    { value: 'exists', label: 'esiste' },
    { value: 'not-exists', label: 'non esiste' },
    { value: 'equals', label: 'è uguale a' },
    { value: 'not-equals', label: 'è diverso da' },
  ],
};

export const TYPE_LABELS: Record<RuleType, string> = {
  string: 'testo',
  number: 'numero',
  date: 'data',
  boolean: 'vero/falso',
  any: 'qualsiasi',
};

/** Gli operatori che non hanno un secondo termine da confrontare. */
export const UNARY_OPS: ReadonlySet<string> = new Set([
  'is-empty',
  'is-not-empty',
  'is-true',
  'is-false',
  'exists',
  'not-exists',
]);

/** Il primo operatore valido per un tipo: serve quando si cambia tipo e
 *  quello scelto prima non esiste più. */
export function defaultOpFor(type: RuleType): string {
  return OPS_BY_TYPE[type][0]?.value ?? 'equals';
}

export function parseRuleset(raw: string): Ruleset {
  if (!raw.trim()) return { combinator: 'AND', rules: [] };
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj && typeof obj === 'object' && Array.isArray((obj as Ruleset).rules)) {
      const o = obj as Ruleset;
      return {
        combinator: o.combinator === 'OR' ? 'OR' : 'AND',
        rules: o.rules.map((r) => {
          const rule: Rule = {
            left: r.left ?? '',
            op: r.op ?? 'equals',
            right: r.right ?? '',
            rightMax: r.rightMax ?? '',
            type: r.type ?? 'string',
          };
          if (r.caseSensitive !== undefined) rule.caseSensitive = r.caseSensitive;
          return rule;
        }),
      };
    }
  } catch {
    // Un valore illeggibile riparte da zero invece di bloccare il pannello.
  }
  return { combinator: 'AND', rules: [] };
}
