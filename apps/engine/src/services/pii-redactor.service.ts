/**
 * PIIRedactor — Italian-aware personally identifiable information remover.
 *
 * Why this exists: we capture AI Assistant interactions for training-set
 * curation (table `ai_interactions`). Those prompts often contain user data
 * — emails, partita IVA, codice fiscale, IBAN, phone numbers — that MUST
 * NOT end up in a fine-tuning corpus. Redaction happens BEFORE insert so
 * the database never sees the raw PII.
 *
 * Strategy: regex-based, conservative. We prefer FALSE POSITIVES (over-redaction)
 * to FALSE NEGATIVES (PII leaks). Each detected pattern is replaced with a
 * placeholder of the same class, so the prompt remains semantically usable
 * for training while being privacy-safe. We also return the list of classes
 * detected so reviewers can spot-check.
 *
 * Italian-specific patterns covered:
 *   • email
 *   • partita IVA (11 digits, optional IT prefix)
 *   • codice fiscale (16 chars: 6 letters + 2 digits + letter + 2 digits + letter + 3 chars + letter)
 *   • IBAN italiano (IT + 2 digits + 1 letter + 10 digits + 12 alnum) → up to 27 chars
 *   • telefono italiano (mobile +39 3xx xxx xxxx and landline +39 0xx xxx xxxx)
 *   • numero carta di credito (15-16 digits, Luhn-checked)
 *
 * Out of scope (for now — handled by manual review):
 *   • Nomi e cognomi (impossible without NER; would over-redact)
 *   • Indirizzi italiani (free-form, too varied)
 *
 * These limits are acceptable for a 1k-sample training set because we ALSO
 * have human review before training_split assignment.
 */

export type PIIClass =
  | 'email'
  | 'codice_fiscale'
  | 'partita_iva'
  | 'iban'
  | 'phone'
  | 'credit_card';

export interface RedactionResult {
  redacted: string;
  classes: PIIClass[];
  counts: Record<PIIClass, number>;
}

const EMPTY_COUNTS = (): Record<PIIClass, number> => ({
  email: 0,
  codice_fiscale: 0,
  partita_iva: 0,
  iban: 0,
  phone: 0,
  credit_card: 0,
});

// Order matters: process IBAN before partita_iva so the digits inside an IBAN
// don't get over-matched as a P.IVA. Process codice_fiscale before phone for
// the same reason (16-char strings with digits could partially match phone).
const PATTERNS: {
  className: PIIClass;
  regex: RegExp;
  placeholder: string;
  postValidate?: (m: string) => boolean;
}[] = [
  // Email — RFC-5321-ish, conservative
  {
    className: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '<EMAIL>',
  },
  // IBAN italiano: IT + 2 digits + 1 letter + 5 ABI + 5 CAB + 12 conto = 27 chars
  {
    className: 'iban',
    regex: /\bIT\d{2}[A-Z]\d{22}\b/g,
    placeholder: '<IBAN>',
  },
  // Codice fiscale: AAA AAA 00 A 00 A 000 A (16 chars). Pattern strict to avoid
  // matching random uppercase strings.
  {
    className: 'codice_fiscale',
    regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/g,
    placeholder: '<CF>',
  },
  // Partita IVA: 11 digits, optional IT prefix. Process AFTER iban (otherwise
  // we'd partial-match IBAN digits).
  {
    className: 'partita_iva',
    regex: /\b(?:IT)?(\d{11})\b/g,
    placeholder: '<PIVA>',
  },
  // Credit card: 13-19 digits, with optional spaces/dashes. Luhn-validated to
  // reduce false positives. Common for order/payment-related workflows.
  {
    className: 'credit_card',
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    placeholder: '<CC>',
    postValidate: (raw: string) => luhnValid(raw.replace(/[ -]/g, '')),
  },
  // Telefono italiano: mobile (3xx xxx xxxx) o fisso (0xx xxx xxxx),
  // con o senza prefisso +39 / 0039.
  {
    className: 'phone',
    regex: /\b(?:(?:\+|00)39\s?)?[03]\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
    placeholder: '<PHONE>',
  },
];

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = parseInt(digits.charAt(i), 10);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export class PIIRedactor {
  /**
   * Redact a single string. Returns the redacted text + list of detected classes.
   * Empty/null input returns empty result with no classes.
   */
  redactText(input: string): RedactionResult {
    if (typeof input !== 'string' || input.length === 0) {
      return { redacted: '', classes: [], counts: EMPTY_COUNTS() };
    }
    let out = input;
    const counts = EMPTY_COUNTS();

    for (const { className, regex, placeholder, postValidate } of PATTERNS) {
      // Reset regex state for global flags between calls
      regex.lastIndex = 0;
      out = out.replace(regex, (match) => {
        if (postValidate && !postValidate(match)) return match;
        counts[className] += 1;
        return placeholder;
      });
    }

    const classes = (Object.keys(counts) as PIIClass[]).filter((c) => counts[c] > 0);
    return { redacted: out, classes, counts };
  }

  /**
   * Redact every string value reachable inside a JSON-serializable object.
   * Arrays, nested objects, and strings are walked; numbers/booleans/null
   * pass through unchanged. Returns the redacted object + union of classes.
   */
  redactJson(value: unknown): { redacted: unknown; classes: PIIClass[] } {
    const allClasses = new Set<PIIClass>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = this.redactText(v);
        for (const c of r.classes) allClasses.add(c);
        return r.redacted;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
          out[k] = walk(item);
        }
        return out;
      }
      return v;
    };
    return { redacted: walk(value), classes: [...allClasses] };
  }
}

/** Singleton instance for convenience — the redactor is stateless. */
export const piiRedactor = new PIIRedactor();
