/**
 * action_validate — validatore enterprise di formati italiani/internazionali con
 * CHECKSUM VERI (non semplici regex): Codice Fiscale, Partita IVA, IBAN usano gli
 * algoritmi di controllo ufficiali. JavaScript puro (zero dipendenze, browser-safe).
 * Sostituisce regex sparse e nodi Code, indispensabile per onboarding clienti,
 * fatturazione e anti-frode nel mercato italiano.
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

// ── Email (RFC-pragmatica) ─────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Partita IVA IT (11 cifre, algoritmo di Luhn ministeriale) ──────────────
function validatePIva(raw: string): boolean {
  const v = raw.replace(/\s/g, '');
  if (!/^\d{11}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    let d = v.charCodeAt(i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// ── Codice Fiscale IT (16 char, carattere di controllo ufficiale) ──────────
const CF_ODD: Record<string, number> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};
function cfEven(c: string): number {
  return c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 65;
}
function validateCodiceFiscale(raw: string): boolean {
  const v = raw.toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{16}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    const c = v[i]!;
    sum += i % 2 === 0 ? (CF_ODD[c] ?? -999) : cfEven(c); // i pari 0-based = posizione dispari
  }
  if (sum < 0) return false;
  return String.fromCharCode(65 + (sum % 26)) === v[15];
}

// ── IBAN (ISO 13616, mod-97 == 1) ───────────────────────────────────────────
function validateIban(raw: string): boolean {
  const v = raw.toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch; // A=10..Z=35
    for (const digit of code) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// ── Telefono IT → E.164 ─────────────────────────────────────────────────────
function normalizePhoneIt(raw: string): { valid: boolean; e164: string | null } {
  let v = raw.replace(/[\s.\-()]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (v.startsWith('+')) return { valid: /^\+\d{8,15}$/.test(v), e164: /^\+\d{8,15}$/.test(v) ? v : null };
  if (/^3\d{8,9}$/.test(v) || /^0\d{5,10}$/.test(v)) return { valid: true, e164: `+39${v}` }; // mobile/fisso IT
  return { valid: false, e164: null };
}

const validateExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const type = str(config.type, 'email');
  const value = str(config.value !== undefined && str(config.value) !== '' ? config.value : input).trim();
  let valid = false;
  let normalized: string | null = value;
  switch (type) {
    case 'email': valid = EMAIL_RE.test(value); normalized = value.toLowerCase(); break;
    case 'url':
      try { const u = new URL(value); valid = u.protocol === 'http:' || u.protocol === 'https:'; normalized = u.href; }
      catch { valid = false; normalized = null; }
      break;
    case 'piva': valid = validatePIva(value); normalized = value.replace(/\s/g, ''); break;
    case 'codice_fiscale': valid = validateCodiceFiscale(value); normalized = value.toUpperCase().replace(/\s/g, ''); break;
    case 'iban': valid = validateIban(value); normalized = value.toUpperCase().replace(/\s/g, ''); break;
    case 'phone_it': { const r = normalizePhoneIt(value); valid = r.valid; normalized = r.e164; break; }
    case 'json':
      try { JSON.parse(value); valid = true; } catch { valid = false; normalized = null; }
      break;
    default:
      throw new Error(`action_validate: tipo sconosciuto "${type}"`);
  }
  return { output: { valid, normalized, type, value }, branch: valid ? 'valid' : 'invalid', durationMs: Date.now() - startedAt };
};

export const validateNode: NodeModule = {
  def: {
    id: 'action_validate',
    type: 'action',
    label: 'Valida',
    icon: 'shield-check',
    color: '#059669',
    description:
      'Validatore enterprise di formati con CHECKSUM REALI — non le solite regex ingenue che accettano un Codice ' +
      'Fiscale o una Partita IVA sintatticamente plausibili ma matematicamente falsi. JavaScript puro (zero ' +
      'dipendenze). Sette tipi da dropdown, ognuno con la sua logica corretta: ' +
      '(1) EMAIL — formato valido, normalizzata in minuscolo; ' +
      '(2) URL — schema http/https valido, normalizzato; ' +
      '(3) PARTITA IVA (IT) — 11 cifre con verifica dell\'algoritmo di Luhn ministeriale (la cifra di controllo ' +
      'deve quadrare, non basta che siano 11 numeri); ' +
      '(4) CODICE FISCALE (IT) — 16 caratteri con calcolo del CARATTERE DI CONTROLLO ufficiale (tabelle ' +
      'pari/dispari del Ministero): individua i codici inventati che passerebbero una regex; ' +
      '(5) IBAN — validazione ISO 13616 mod-97 (sposta i primi 4 caratteri, converte le lettere, resto su 97 = ' +
      '1): scarta gli IBAN con una cifra sbagliata, prima di tentare un bonifico; ' +
      '(6) TELEFONO (IT) — normalizza qualsiasi formato (spazi, prefissi, 00/+) in E.164 (+39…), distinguendo ' +
      'mobile e fisso; ' +
      '(7) JSON — verifica che una stringa sia JSON parsabile. ' +
      'Il nodo è anche RAMIFICATO: espone due uscite "valid" e "invalid" così puoi instradare il flusso senza un ' +
      'nodo IF aggiuntivo. Output: { valid, normalized, type, value } + branch. ' +
      'Use case: valida la Partita IVA inserita in un form prima di creare la fattura (scarta le false); verifica ' +
      'l\'IBAN del fornitore prima del bonifico (anti-errore di battitura); normalizza i telefoni dei lead in E.164 ' +
      'per l\'invio SMS; controlla il Codice Fiscale in onboarding cliente; instrada le email non valide a un ramo ' +
      'di correzione.',
    configFields: [
      {
        key: 'type', label: 'Tipo da validare', type: 'select', required: true, defaultValue: 'email',
        options: ['email', 'url', 'piva', 'codice_fiscale', 'iban', 'phone_it', 'json'],
        help: 'email · url · piva (P.IVA IT) · codice_fiscale (CF IT) · iban · phone_it · json.',
      },
      {
        key: 'value', label: 'Valore', type: 'expression', required: false, defaultValue: 'input',
        help: 'Il valore da validare. Vuoto = usa l\'input del nodo.',
      },
    ],
    outputs: ['valid', 'invalid'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: validateExecutor,
};
