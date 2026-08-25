/**
 * `REGOLE_CONDIZIONE_MALFORMATE` — una condizione che non verrà mai valutata.
 *
 * Il 2026-08-15 il wizard ha consegnato «Monitoraggio prezzo prodotto» con
 * questo `logic_if`:
 *
 *     [{"field":"prezzo","op":"<","value":"{{prezzo_precedente}}"}]
 *
 * Quattro errori in una riga, e ognuno da solo basta a farla fallire:
 * `parseRuleset` vuole un OGGETTO con `rules`, non un array nudo; il campo si
 * chiama `left`, non `field`; il confronto si chiama `right`, non `value`;
 * l'operatore è `lt`, non `<`.
 *
 * Quando il parsing fallisce, `logic_if` ripiega sul vecchio campo `condition`
 * a testo libero — che qui non c'era — e la condizione vale **`false`**. Il
 * workflow sarebbe partito ogni mattina, per sempre, senza mai mandare
 * l'avviso: nessun errore, nessuna email, nessun modo di accorgersene se non
 * aspettando un ribasso che non arriva mai.
 *
 * È il difetto peggiore di questa specie: non rompe niente, non segnala
 * niente, e trasforma un'automazione in un rituale a vuoto.
 *
 * @module services/ai-scaffold/rule-regole-condizione
 */

import type { QualityGateInput, QualityIssue } from '@/services/ai-scaffold/quality-gate.js';

/** I nodi che valutano un insieme di regole. */
const NODI_CON_REGOLE: ReadonlySet<string> = new Set(['logic_if', 'logic_switch']);

/**
 * Gli operatori che l'esecutore conosce davvero.
 *
 * Presi da `condition-rules.ts`: un operatore inventato — `<`, `>=`, `==` —
 * non fa fallire il parsing, fa fallire il CONFRONTO, che è peggio perché non
 * si vede.
 */
const OPERATORI: ReadonlySet<string> = new Set([
  'equals',
  'not-equals',
  'contains',
  'not-contains',
  'starts-with',
  'ends-with',
  'matches-regex',
  'is-empty',
  'is-not-empty',
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'before',
  'after',
  'is-true',
  'is-false',
  'exists',
  'not-exists',
]);

/** La forma giusta, da mettere nel messaggio: si corregge leggendo. */
const FORMA =
  '{"combinator":"AND","rules":[{"left":"{{$node.<id>.json.<campo>}}",' +
  '"op":"lt","right":"100","type":"number"}]}';

function problemaDi(grezzo: unknown): string | null {
  if (typeof grezzo !== 'string' || grezzo.trim() === '') return null;

  let letto: unknown;
  try {
    letto = JSON.parse(grezzo);
  } catch {
    return 'non è JSON valido';
  }

  // Il caso vero: un array nudo. `parseRuleset` cerca `.rules` e non lo trova,
  // quindi restituisce null e la condizione diventa `false`.
  if (Array.isArray(letto)) {
    return 'è un array nudo, ma serve un oggetto con `combinator` e `rules`';
  }
  if (letto === null || typeof letto !== 'object') {
    return 'non è un oggetto';
  }

  const o = letto as Record<string, unknown>;
  if (!Array.isArray(o.rules) || o.rules.length === 0) {
    return 'non ha nessuna regola dentro `rules`';
  }

  const guasti: string[] = [];
  for (const [i, r] of (o.rules as unknown[]).entries()) {
    if (r === null || typeof r !== 'object') {
      guasti.push(`la regola ${String(i + 1)} non è un oggetto`);
      continue;
    }
    const regola = r as Record<string, unknown>;
    if (typeof regola.left !== 'string' || regola.left.trim() === '') {
      // `field` e `value` sono i nomi che il modello sbaglia più spesso:
      // dirglielo per nome vale più di «campo mancante».
      const suggerimento = typeof regola.field === 'string' ? ' (hai scritto `field`)' : '';
      guasti.push(`alla regola ${String(i + 1)} manca \`left\`${suggerimento}`);
    }
    const op = typeof regola.op === 'string' ? regola.op : '';
    if (!OPERATORI.has(op)) {
      const suggerimento =
        typeof regola.value === 'string' && typeof regola.right !== 'string'
          ? ' — e il confronto si chiama `right`, non `value`'
          : '';
      guasti.push(
        `la regola ${String(i + 1)} usa l'operatore «${op || '(vuoto)'}», che non esiste${suggerimento}`,
      );
    }
  }
  return guasti.length > 0 ? guasti.join('; ') : null;
}

export function checkRegoleCondizione(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];

  for (const node of input.nodes) {
    if (!NODI_CON_REGOLE.has(node.defId)) continue;

    const problema = problemaDi(node.config.conditionRules);
    if (problema === null) continue;

    issues.push({
      severity: 'critical',
      code: 'REGOLE_CONDIZIONE_MALFORMATE',
      nodeId: node.id,
      field: 'conditionRules',
      message:
        `Le regole di "${node.id}" non verranno mai valutate: ${problema}. ` +
        'Quando la lettura fallisce la condizione vale FALSO e il ramo non parte mai — ' +
        'senza errori, senza segnali, per sempre. ' +
        `Scrivile così: ${FORMA}. ` +
        `Operatori ammessi: ${[...OPERATORI].join(', ')}.`,
    });
  }
  return issues;
}
