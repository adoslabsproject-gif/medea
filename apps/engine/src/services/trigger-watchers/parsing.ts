/**
 * trigger-watchers/parsing — primitive PURE di interpretazione input esterni.
 *
 * Estratte dal monolite `trigger-watchers.service.ts` (split 2026-06-12). Sono
 * il confine di fiducia dei trigger: traducono input NON fidati (config operatore,
 * payload WebSocket, header email) in valori interni sicuri. Tenerle isolate e
 * pure è una scelta di sicurezza, non solo di igiene:
 *   - testabili in isolamento, esaustivamente (incluso prototype-pollution,
 *     regex injection, dedup/normalizzazione);
 *   - zero dipendenze dallo stato della classe → nessun effetto collaterale
 *     nascosto;
 *   - una sola responsabilità: "interpreta input ostile → valore canonico".
 *
 * Comportamento IDENTICO all'originale (caratterizzato dai test): questo è uno
 * split strutturale, non un cambio semantico.
 */

import type { AddressObject } from 'mailparser';
import { safeUserRegex } from '@flowforge/nodes-stdlib';
import { logger } from '@/lib/logger.js';

/**
 * Risolve un RFC 6901 JSON Pointer su un documento (filtro del trigger
 * WebSocket). Contratto:
 *   - `''` → l'intero documento (per definizione RFC 6901).
 *   - pointer senza `/` iniziale → `undefined` (input malformato → no match).
 *   - token-escaping `~1`→`/`, `~0`→`~` (ordine RFC: prima `~1`, poi `~0`).
 *   - array: solo indici interi in range; fuori range / non-intero → `undefined`.
 *   - oggetti: SOLO proprietà OWN (`hasOwnProperty`). Questo è il bastione
 *     anti prototype-pollution-READ: `/__proto__/x` o `/constructor` NON
 *     discendono nella prototype chain → `undefined`.
 *   - un valore falsy (`0`, `false`, `''`) è un match VALIDO (≠ `undefined`).
 */
export function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  const tokens = pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = doc;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return undefined;
      cur = (cur as Record<string, unknown>)[tok];
    }
  }
  return cur;
}

/** Modalità di marcatura \Seen di un messaggio IMAP dopo il trigger. */
export type MarkSeenMode = 'always' | 'on-success' | 'never';

/**
 * Interpreta il campo config `markSeen`. Idempotency-critical in produzione:
 *  - `'on-success'` (DEFAULT sicuro): marca letto solo se il run è riuscito →
 *    nessuna perdita silenziosa di ordini reali.
 *  - `'always'`: marca sempre (anche legacy boolean `true`/`'true'`).
 *  - `'never'`: l'operatore gestisce i flag a mano.
 * Qualunque altro input (missing/falsy/sconosciuto) → `'on-success'`.
 */
export function parseMarkSeen(raw: unknown): MarkSeenMode {
  if (raw === 'on-success' || raw === 'always' || raw === 'never') return raw;
  if (raw === true || raw === 'true') return 'always';
  return 'on-success';
}

/**
 * Normalizza il campo `allowlist` in `string[]` deduplicato e lowercase.
 * Accetta TRE forme (back-compat + future-proofing):
 *   - JSON array string: `'["a@x.com","b@y.com"]'` (default UI chip-list);
 *   - stringa separata da virgola/punto-e-virgola/newline: `'a@x.com; b@y.com'`;
 *   - `string[]` già parsato (chiamanti programmatici).
 * Tiene solo i token con `@` (sono indirizzi email). Qualunque altra forma → `[]`
 * (= "nessuna allowlist" per il chiamante). Un JSON array malformato che inizia
 * con `[` viene trattato come singolo token grezzo (fallback robusto).
 */
export function parseAllowlist(raw: unknown): string[] {
  const tokens: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') tokens.push(item);
    }
  } else if (typeof raw === 'string' && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) if (typeof item === 'string') tokens.push(item);
        }
      } catch {
        tokens.push(trimmed);
      }
    } else {
      tokens.push(...trimmed.split(/[,;\n]+/));
    }
  }
  return Array.from(
    new Set(
      tokens
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0 && s.includes('@')),
    ),
  );
}

/**
 * Compila un regex fornito dall'operatore SENZA lanciare su pattern errato.
 * Riconosce la forma `/pattern/flags` (altrimenti nessun flag). Pattern invalido
 * → `null` + warn (il chiamante tratta `null` come "match qualsiasi"). È un punto
 * di hardening: un pattern ostile/typo non deve mai crashare il poller.
 */
export function safeRegex(pattern: string): RegExp | null {
  try {
    // RE2 (safeUserRegex): il pattern dell'operatore è testato contro subject/sender di
    // email IN ARRIVO (attacker-controlled) → `new RegExp` di V8 backtrack-erebbe (ReDoS,
    // es. `(a+)+$` + subject ostile blocca il poller). RE2 = lineare, immune by-design.
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
    return m ? safeUserRegex(m[1] ?? '', m[2] ?? '') : safeUserRegex(pattern);
  } catch {
    logger.warn({ pattern }, 'IMAP trigger: invalid regex — filter ignored');
    return null;
  }
}

/**
 * Primo indirizzo email da un `AddressObject` (o array) di mailparser.
 * `''` se assente — mai `undefined`, così il chiamante può sempre confrontare.
 */
export function pickAddress(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return '';
  const first = Array.isArray(addr) ? addr[0] : addr;
  return first?.value?.[0]?.address ?? '';
}

/**
 * TUTTI gli indirizzi email da un `AddressObject` (o array) — appiattito,
 * scartando le entry senza `.address` (es. gruppi senza membri). Per i filtri
 * `to`/`cc` che devono controllare ogni destinatario.
 */
export function collectAddresses(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (!addr) return [];
  const arr = Array.isArray(addr) ? addr : [addr];
  const out: string[] = [];
  for (const a of arr) {
    for (const v of a.value ?? []) {
      if (v.address) out.push(v.address);
    }
  }
  return out;
}

/**
 * FIX bug NaN/overflow (2026-06-12): clamp di un valore numerico di config dei
 * watcher in `[min, max]`. Input non-finito (stringa spazzatura, NaN,
 * ±Infinity, oggetti) → `fallback`. MAI NaN in uscita.
 *
 * Pre-fix il pattern era `Math.max(min, Number(raw ?? def))`: con raw='abc'
 * dava NaN, e `setInterval(NaN)` in Node degrada a ~1ms → un poller
 * configurato male martellava il DB/IMAP/Odoo del tenant migliaia di volte al
 * secondo. Il max previene anche l'overflow di setInterval (delay > 2^31-1 ms
 * degrada anch'esso a 1ms).
 */
export function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
