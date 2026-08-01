/**
 * Commenti workflow — logica pura (Tier 3 multi-user, #7). Estrazione delle
 * @mentions dal corpo di un commento, per le notifiche + l'highlight UI.
 */

/**
 * Estrae le @mention da un testo. Una mention è `@handle` preceduta da inizio
 * stringa o spazio (no email come a@b.it nel mezzo di una parola). Ritorna gli
 * handle UNICI, nell'ordine di apparizione, senza la `@`.
 */
export function parseMentions(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9._-]*)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const handle = m[1]!;
    if (!seen.has(handle)) { seen.add(handle); out.push(handle); }
  }
  return out;
}
