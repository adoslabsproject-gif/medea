/**
 * PROOF — il mapping dinamico label→valore SI FA GIÀ nel workflow, senza
 * modificare alcun nodo.
 *
 * Contesto (2026-06-24): un agente ha sostenuto che il motore espressioni ha solo
 * `$get(obj, "path-letterale")` → "niente object-lookup dinamico né ternary",
 * chiedendo di estendere agent_classifier con operatorsJson/suggestedOperator.
 * FALSO su entrambi i punti:
 *   - `$get(map, runtimeKey, fallback)` è un LOOKUP DINAMICO (la key è un valore
 *     valutato a runtime, non deve essere letterale);
 *   - `$if(cond, then, els)` È il ternary.
 * E `interpolateString` valuta il motore PIENO sui {{ }} dei config field.
 *
 * Questi test FALLIREBBERO se il motore non supportasse davvero quanto sopra.
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression, interpolateString } from './interpreter.js';

const scope = {
  input: {
    label: 'lead',
    confidence: 0.92,
    operators: { lead: 'sales@studio.it', support: 'help@studio.it', spam: 'trash@studio.it' },
  },
};

describe('PROOF: lookup dinamico label→operatore (zero modifiche nodo)', () => {
  it('🚨 $get(map, runtimeKey, fallback) risolve la key DINAMICA (output del classifier)', () => {
    expect(evaluateExpression('$get($json.operators, $json.label, "x@x.it")', scope)).toBe(
      'sales@studio.it',
    );
  });

  it('🚨 funziona DENTRO un config field ({{ }} → interpolateString, motore pieno)', () => {
    expect(interpolateString('{{ $get($json.operators, $json.label, "x@x.it") }}', scope)).toBe(
      'sales@studio.it',
    );
  });

  it('🚨 $if = ternary: gate di confidence (sotto soglia → operatore umano)', () => {
    const expr =
      '{{ $if($number($json.confidence) >= 0.8, $get($json.operators, $json.label, "human@studio.it"), "human@studio.it") }}';
    expect(interpolateString(expr, scope)).toBe('sales@studio.it');
    const lowConf = { input: { ...scope.input, confidence: 0.3 } };
    expect(interpolateString(expr, lowConf)).toBe('human@studio.it');
  });

  it('🚨 key non mappata → fallback (no crash, no valore sbagliato)', () => {
    const unknown = { input: { label: 'boh', operators: { lead: 'sales@studio.it' } } };
    expect(
      interpolateString('{{ $get($json.operators, $json.label, "fallback@studio.it") }}', unknown),
    ).toBe('fallback@studio.it');
  });
});
