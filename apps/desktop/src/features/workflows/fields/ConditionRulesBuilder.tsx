/**
 * Le condizioni di un `logic_if`, scritte a regole invece che a mano.
 *
 * Formato salvato — quello che valuta il motore:
 *   `{ combinator: 'AND'|'OR', rules: [{ left, op, right, rightMax?, type, caseSensitive? }] }`
 *
 * Gli operatori disponibili dipendono dal tipo scelto: su un numero non ha
 * senso «contiene», su una stringa non ha senso «≥». È la differenza fra un
 * campo che aiuta e un campo che lascia sbagliare.
 */

import { useState } from 'react';

import {
  defaultOpFor,
  OPS_BY_TYPE,
  parseRuleset,
  TYPE_LABELS,
  UNARY_OPS,
  type Rule,
  type RuleType,
  type Ruleset,
} from './condition-ops';
import styles from './fields.module.css';

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function ConditionRulesBuilder({ value, onChange }: Props) {
  const [set, setSet] = useState<Ruleset>(() => parseRuleset(value));

  const commit = (next: Ruleset) => {
    setSet(next);
    onChange(JSON.stringify(next));
  };

  const patchRule = (index: number, patch: Partial<Rule>) => {
    commit({
      ...set,
      rules: set.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  };

  return (
    <div className={styles.builder}>
      <div className={styles.combinator}>
        {(['AND', 'OR'] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={styles.combinatorBtn}
            data-on={set.combinator === c ? 'true' : 'false'}
            onClick={() => {
              commit({ ...set, combinator: c });
            }}
          >
            {c === 'AND' ? 'tutte le condizioni' : 'almeno una'}
          </button>
        ))}
      </div>

      {set.rules.map((rule, i) => {
        const ops = OPS_BY_TYPE[rule.type];
        const unary = UNARY_OPS.has(rule.op);
        return (
          <div key={i} className={styles.ruleRow}>
            <div className={styles.row}>
              <select
                className={styles.controlNarrow}
                aria-label="Tipo di confronto"
                value={rule.type}
                onChange={(e) => {
                  const type = e.target.value as RuleType;
                  // Cambiando tipo l'operatore precedente può non esistere più.
                  patchRule(i, { type, op: defaultOpFor(type) });
                }}
              >
                {(Object.keys(OPS_BY_TYPE) as RuleType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.rowRemove}
                aria-label="Rimuovi questa condizione"
                onClick={() => {
                  commit({ ...set, rules: set.rules.filter((_, j) => j !== i) });
                }}
              >
                ✕
              </button>
            </div>

            <input
              className={styles.control}
              placeholder="{{$node.passo.json.campo}}"
              aria-label="Valore da confrontare"
              value={rule.left}
              onChange={(e) => {
                patchRule(i, { left: e.target.value });
              }}
            />

            <div className={styles.row}>
              <select
                className={styles.control}
                aria-label="Operatore"
                value={rule.op}
                onChange={(e) => {
                  patchRule(i, { op: e.target.value });
                }}
              >
                {ops.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              {!unary && (
                <input
                  className={styles.control}
                  placeholder={rule.op === 'between' ? 'minimo' : 'valore'}
                  aria-label="Termine di confronto"
                  value={rule.right ?? ''}
                  onChange={(e) => {
                    patchRule(i, { right: e.target.value });
                  }}
                />
              )}
              {rule.op === 'between' && (
                <input
                  className={styles.control}
                  placeholder="massimo"
                  aria-label="Valore massimo"
                  value={rule.rightMax ?? ''}
                  onChange={(e) => {
                    patchRule(i, { rightMax: e.target.value });
                  }}
                />
              )}
            </div>

            {rule.type === 'string' && !unary && (
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={rule.caseSensitive === true}
                  onChange={(e) => {
                    patchRule(i, { caseSensitive: e.target.checked });
                  }}
                />
                Distingui maiuscole e minuscole
              </label>
            )}
          </div>
        );
      })}

      <button
        type="button"
        className={styles.addRow}
        onClick={() => {
          commit({
            ...set,
            rules: [...set.rules, { left: '', op: 'equals', right: '', type: 'string' }],
          });
        }}
      >
        + Aggiungi condizione
      </button>
    </div>
  );
}
