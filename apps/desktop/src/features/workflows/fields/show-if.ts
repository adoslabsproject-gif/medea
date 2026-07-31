/**
 * Quando un campo va mostrato e quando no.
 *
 * Molti nodi hanno campi che dipendono da un'altra scelta: il corpo della
 * richiesta ha senso solo con metodo POST, la password solo se
 * l'autenticazione è attiva. Mostrarli sempre significa chiedere all'utente
 * di capire da solo quali contano.
 *
 * Regole identiche a quelle del server — un campo nascosto là deve essere
 * nascosto anche qui.
 */

export interface ShowIfRule {
  field: string;
  equals?: string | number | boolean;
  in?: (string | number | boolean)[];
  truthy?: boolean;
}

/** Il valore di un campo come testo, senza mai produrre "[object Object]":
 *  un oggetto confrontato con una stringa non corrisponde mai, e va bene così. */
function asComparable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

export function evaluateShowIf(
  rule: ShowIfRule | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!rule) return true;
  const v = values[rule.field];
  if (rule.equals !== undefined) return String(rule.equals) === asComparable(v);
  if (rule.in) return rule.in.map(String).includes(asComparable(v));
  if (rule.truthy !== undefined) {
    const isTruthy = Boolean(v) && v !== 'false' && v !== '0';
    return rule.truthy === isTruthy;
  }
  return true;
}
