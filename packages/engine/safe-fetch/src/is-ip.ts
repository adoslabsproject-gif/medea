/**
 * isomorphic `isIP` — pure-JS implementation of `node:net#isIP`.
 *
 * Pre-fix: `ssrf-guard.ts` importava `node:net` direttamente. Quando il
 * pacchetto `@flowforge/safe-fetch` viene incluso nel bundle browser
 * (cascade workspace: editor SPA → nodes-stdlib → safe-fetch), Vite
 * non risolve `node:net` → build fail "isIP not exported by
 * __vite-browser-external".
 *
 * Fix: implementazione pure-JS isomorphic, semantica equivalente a
 * `node:net#isIP` per gli input che ci interessano (input utente / LLM
 * URL hostname). I 42 test SSRF del pacchetto coprono i casi reali.
 *
 * Compatibilità Node `isIP`:
 *   - Ritorna 4 per IPv4 valido (es. "127.0.0.1")
 *   - Ritorna 6 per IPv6 valido (es. "::1", "fe80::1", "::ffff:1.2.3.4")
 *   - Ritorna 0 per stringa che non è un IP letterale
 *
 * Non-goals: parsing esoterico (zone-id %eth0, IPv4 octal/hex obfuscato). Gli IPv4
 * offuscati (decimale `2130706433`, hex `0x7f000001`, ottale `0177.0.0.1`) sono
 * normalizzati a dotted-decimal da `normalizeObfuscatedIPv4` in ssrf-guard.ts PRIMA
 * di chiamare `isIP` (test: ssrf-guard.test.ts "IPv4 offuscati"). NB: questa funzione
 * da sola NON li riconosce — il check completo è quella catena, non `isIP` isolato.
 */

/** IPv4: 4 ottetti decimali 0-255, no leading zero (eccetto "0"). */
function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const part = m[i]!;
    const n = Number(part);
    // Range check + reject leading zeros (Node `isIP` rejects "01.2.3.4").
    if (n < 0 || n > 255) return false;
    if (String(n) !== part) return false;
  }
  return true;
}

/** IPv6: gruppi hex separati da `:`, opz. forma compressa `::`, IPv4-mapped finale. */
function isIPv6(s: string): boolean {
  if (s === '') return false;
  if (s === '::') return true;
  // Più di una occorrenza di `::` non è valida.
  const compressedHits = (s.match(/::/g) ?? []).length;
  if (compressedHits > 1) return false;
  // `:::` (3 colons) non è valida.
  if (s.includes(':::')) return false;

  let groups: string[];
  if (compressedHits === 1) {
    const parts = s.split('::');
    const left = parts[0] ?? '';
    const right = parts[1] ?? '';
    const lparts = left === '' ? [] : left.split(':');
    const rparts = right === '' ? [] : right.split(':');
    // Compressione rappresenta almeno 1 gruppo zero → totale ≤ 7 (compressione
    // implica almeno 1 gruppo zero implicito; ≤8 totali).
    if (lparts.length + rparts.length >= 8) return false;
    groups = [...lparts, ...rparts];
  } else {
    groups = s.split(':');
    if (groups.length !== 8) return false;
  }

  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i]!;
    if (g === '') return false;
    // Gruppo hex standard: 1-4 caratteri esadecimali.
    if (/^[0-9a-fA-F]{1,4}$/.test(g)) continue;
    // Eccezione: IPv4-mapped IPv6 (`::ffff:1.2.3.4`) — l'ultimo gruppo può
    // essere un IPv4 dotted-decimal. Solo se è l'ULTIMO gruppo.
    if (i === groups.length - 1 && isIPv4(g)) continue;
    return false;
  }
  return true;
}

/** Equivalente isomorphic di `node:net#isIP`. Restituisce 0 / 4 / 6. */
export function isIP(s: string): 0 | 4 | 6 {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}
