/**
 * Pure email body cleaner — drops the noise BEFORE the LLM sees it.
 *
 * Why this is critical for studio commercialista
 * ──────────────────────────────────────────────
 * A real customer mail looks like:
 *
 *     "Buongiorno, vi mando i documenti per il 730. Grazie. Mario."
 *     [\n--\nMario Rossi - Studio Tributario\nVia X 12, 00100 Roma
 *      Tel: 06 12345 - Mobile: 333 1234567\nP.IVA: 12345678901
 *      "PER PROTEGGERE L'AMBIENTE NON STAMPARE..."]
 *     [Inviato dal mio iPhone]
 *     [On 2026-01-15 14:32, Mario Rossi wrote:
 *      > Quoted reply of 200 lines from a 3-month conversation]
 *
 * The 30-token actual message gets buried under 800 tokens of signature,
 * disclaimer and quoted reply. The downstream LLM (Liara) sees garbage,
 * spends budget, and emits less accurate labels.
 *
 * This cleaner runs locally on the worker (zero LLM cost) and returns ONLY
 * the actual message, plus a manifest of what was dropped. The manifest is
 * surfaced in the workflow output so the operator can audit edge cases
 * without re-running with the raw body.
 *
 * Pure (no I/O, deterministic, no globals).
 *
 * @module lib/email/cleaner
 */

export interface EmailCleanOptions {
  /** Drop the "On …, X wrote:" / "Il giorno X ha scritto:" quoted reply block (default true). */
  stripQuotedReply?: boolean;
  /** Drop signature block detected by `-- ` or "Inviato da iPhone" markers (default true). */
  stripSignatures?: boolean;
  /** Drop legal disclaimers ("This email is confidential..." etc, default true). */
  stripDisclaimers?: boolean;
  /** Strip tracking URLs (UTM, click-tracking) and replace with bare domain (default false). */
  stripTrackingUrls?: boolean;
  /** Hard cap on cleaned body length in characters (default 8192). */
  maxBodyLength?: number;
  /** Collapse runs of >2 blank lines to a single blank (default true). */
  collapseBlankLines?: boolean;
}

export interface EmailCleanResult {
  /** The cleaned body. Never null — falls back to original (truncated) if nothing matched. */
  cleanedBody: string;
  /** True when the quoted-reply detector found and removed a block. */
  removedQuotedReply: boolean;
  /** True when a signature was detected and removed. */
  removedSignature: boolean;
  /** True when one or more disclaimer patterns matched. */
  removedDisclaimer: boolean;
  /** Tracking-URL substitutions performed (0 if disabled / none matched). */
  trackingUrlsReplaced: number;
  /** Body length BEFORE cleaning, in characters. */
  originalLength: number;
  /** Body length AFTER cleaning, in characters. */
  cleanedLength: number;
  /** `cleanedLength / max(originalLength, 1)` — useful for telemetry. */
  reductionRatio: number;
}

const DEFAULTS: Required<EmailCleanOptions> = {
  stripQuotedReply: true,
  stripSignatures: true,
  stripDisclaimers: true,
  stripTrackingUrls: false,
  maxBodyLength: 8192,
  collapseBlankLines: true,
};

/**
 * Top-level entry. Apply the configured strippers in a deterministic order:
 *   1. unify line endings
 *   2. detect & drop quoted reply (cheap, narrows the working set)
 *   3. detect & drop signature
 *   4. detect & drop disclaimer paragraphs
 *   5. optional URL tracking strip
 *   6. collapse blanks
 *   7. truncate
 */
export function cleanEmailBody(rawBody: string, opts: EmailCleanOptions = {}): EmailCleanResult {
  const cfg = { ...DEFAULTS, ...opts };
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return {
      cleanedBody: '',
      removedQuotedReply: false,
      removedSignature: false,
      removedDisclaimer: false,
      trackingUrlsReplaced: 0,
      originalLength: 0,
      cleanedLength: 0,
      reductionRatio: 1,
    };
  }

  const original = rawBody;
  let body = rawBody.replace(/\r\n?/g, '\n');

  let removedQuotedReply = false;
  let removedSignature = false;
  let removedDisclaimer = false;
  let trackingUrlsReplaced = 0;

  if (cfg.stripQuotedReply) {
    const next = stripQuotedReply(body);
    if (next !== body) {
      removedQuotedReply = true;
      body = next;
    }
  }
  if (cfg.stripSignatures) {
    const next = stripSignature(body);
    if (next !== body) {
      removedSignature = true;
      body = next;
    }
  }
  if (cfg.stripDisclaimers) {
    const next = stripDisclaimers(body);
    if (next !== body) {
      removedDisclaimer = true;
      body = next;
    }
  }
  if (cfg.stripTrackingUrls) {
    const r = stripTrackingUrls(body);
    body = r.text;
    trackingUrlsReplaced = r.replaced;
  }
  if (cfg.collapseBlankLines) {
    body = body.replace(/\n{3,}/g, '\n\n');
  }
  body = body.trim();
  if (body.length > cfg.maxBodyLength) {
    body = body.slice(0, cfg.maxBodyLength).trimEnd() + '…';
  }

  return {
    cleanedBody: body,
    removedQuotedReply,
    removedSignature,
    removedDisclaimer,
    trackingUrlsReplaced,
    originalLength: original.length,
    cleanedLength: body.length,
    reductionRatio: body.length / Math.max(original.length, 1),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Quoted reply
// ────────────────────────────────────────────────────────────────────────────

/**
 * Recognises the most common reply quoting patterns:
 *   • RFC ">"-prefixed lines (Outlook plain text, mutt, ...)
 *   • "On 2026-01-15 …, X wrote:" (Gmail/Outlook EN)
 *   • "Il giorno …, X ha scritto:" (Gmail/Outlook IT)
 *   • "Le X ha scritto:" / "Da: …\nInviato: …" (Outlook IT)
 *   • "----- Forwarded message -----" / "---------- Forwarded message"
 *
 * Returns the body cut at the FIRST recognised divider. Inline ">" lines
 * are normalised LAST to avoid clobbering text bodies that happen to use
 * ">" as a punctuation char.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.split('\n');
  let cutAt = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!.trim();
    if (l.length === 0) continue;
    if (matchesReplyDivider(l)) {
      cutAt = i;
      break;
    }
  }

  // Look ahead for a contiguous block of ">"-prefixed lines (4 or more).
  // Strong quoted-block signal even without a divider header. ONLY ">" lines
  // count toward the run — blank lines reset it to keep the heuristic from
  // misfiring on bodies with 4+ blank lines.
  if (cutAt === -1) {
    let run = 0;
    let runStart = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i]!;
      if (/^>\s?/.test(l)) {
        if (run === 0) runStart = i;
        run += 1;
        if (run >= 4) {
          cutAt = runStart;
          break;
        }
      } else {
        run = 0;
        runStart = -1;
      }
    }
  }
  if (cutAt <= 0) return body;
  return lines.slice(0, cutAt).join('\n').trimEnd();
}

/**
 * Sanity-bound sulla lunghezza di una riga divider. NB: le pattern sono ora LINEARI
 * (un solo gruppo `[^\n]{4,140}` con àncora letterale dopo → backtracking limitato da una
 * COSTANTE, non O(n²)), quindi il vero anti-ReDoS è la regex stessa; questo cap resta solo
 * come difesa-in-profondità (un divider reale è ≤ ~160 char). Pre-fix: le pattern ambigue
 * `.{4,80},?\s*.{1,80}\s+` backtrack-avano ~250ms/riga anche col cap a 256 → DoS-per-volume
 * (256KB di body ≈ 1000 righe = ~250s). La riscrittura lineare lo azzera.
 */
const MAX_DIVIDER_LINE_LEN = 200;

/**
 * Recognises a line that introduces a quoted reply block. Matched in
 * priority order — longest patterns first to avoid the IT "Le X ha scritto"
 * pattern stealing matches from the EN one.
 */
function matchesReplyDivider(line: string): boolean {
  // Difesa-in-profondità: una riga oltre il cap non è un divider (sono corti).
  if (line.length > MAX_DIVIDER_LINE_LEN) return false;
  return (
    /^-{2,}\s*forwarded message\s*-{2,}/i.test(line) ||
    // LINEARE: un solo `[^\n]{4,140}` + àncora `\bwrote:?\s*$` (niente secondo gruppo
    // variabile sovrapposto → nessun backtracking esponenziale/quadratico).
    /^on [^\n]{4,140}\bwrote:?\s*$/i.test(line) ||
    /^il giorno [^\n]{4,140}\b(ha\s+scritto|hai\s+scritto):?\s*$/i.test(line) ||
    (/^le\s+\d/.test(line) && /\bha\s+scritto:?\s*$/i.test(line)) ||
    /^da:\s/i.test(line) ||
    (/^from:\s/i.test(line) && lineLooksLikeOutlookHeader(line))
  );
}
function lineLooksLikeOutlookHeader(line: string): boolean {
  // "From: Mario Rossi" alone could be inside a regular message. Require
  // Outlook-style email header anchor (presence of >). This keeps regular
  // body lines starting with "From:" from triggering.
  return line.includes('<') || line.includes('@');
}

// ────────────────────────────────────────────────────────────────────────────
// Signature
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip RFC-3676 signature delimiter `"-- "` (dash-dash-space) followed by
 * up to ~12 lines, OR a "Inviato da iPhone/Android" / "Sent from my iPhone"
 * style mobile auto-sig. Falls back to a generic "blank-then-≤4-short-lines
 * at end" heuristic. Always preserves text BEFORE the delimiter.
 */
export function stripSignature(body: string): string {
  const lines = body.split('\n');

  // 1) RFC-3676 hard delimiter
  const sigIdx = lines.findIndex((l) => l === '-- ' || l === '--');
  if (sigIdx > 0 && sigIdx >= lines.length - 18) {
    return lines.slice(0, sigIdx).join('\n').trimEnd();
  }

  // 2) Mobile auto-signature
  const mobileIdx = lines.findIndex((l) =>
    /^(inviato\s+(da|dal\s+mio)|sent\s+from\s+my)\s+(iphone|ipad|samsung|android|huawei|smartphone|mio\s+(iphone|ipad|samsung|android|smartphone))/i.test(
      l.trim(),
    ),
  );
  if (mobileIdx > 0 && mobileIdx >= lines.length - 4) {
    return lines.slice(0, mobileIdx).join('\n').trimEnd();
  }

  // 3) Generic: last paragraph is short (<60 chars per line) and starts with
  //    a name/company line + contact info (P.IVA, Tel:, Cell:, Mobile:, email).
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i += 1) {
    const l = lines[i]!;
    if (
      /^(p\.?\s*iva|p\.iva|tel\.?|cell\.?|mobile|email|fax|sede legale|via\s+\w)/i.test(l.trim())
    ) {
      // Walk backwards to find the start of the signature block (last blank).
      let start = i;
      while (start > 0 && lines[start - 1]!.trim() !== '') start -= 1;
      if (start > 0) return lines.slice(0, start).join('\n').trimEnd();
    }
  }

  return body;
}

// ────────────────────────────────────────────────────────────────────────────
// Legal disclaimer
// ────────────────────────────────────────────────────────────────────────────

const DISCLAIMER_PATTERNS = [
  /this (e[- ]?mail|message) (and any attachments?|contains?) .*?(confidential|privileged)[\s\S]*?(\.|$)/i,
  /le informazioni contenute nel presente messaggio[\s\S]*?(\.|$)/i,
  /il presente messaggio (e`|è|e') destinato (esclusivamente|unicamente)[\s\S]*?(\.|$)/i,
  /per proteggere l'ambiente non stampare[\s\S]*?(\.|$)/i,
  /please consider the environment[\s\S]*?(\.|$)/i,
  /informativa privacy (?:gdpr|reg|articolo|art\.?)[\s\S]*?(\.|$)/i,
  /ai sensi del (?:reg|d\.lgs|decreto)[\s\S]*?(\.|$)/i,
];

/**
 * Drop any paragraph that matches one of `DISCLAIMER_PATTERNS`. We do NOT
 * match against the whole body in one shot to avoid eating actual content
 * that sits between two disclaimers — paragraph-by-paragraph keeps it
 * surgical.
 */
export function stripDisclaimers(body: string): string {
  const paragraphs = body.split(/\n{2,}/);
  const kept: string[] = [];
  for (const p of paragraphs) {
    let matched = false;
    for (const re of DISCLAIMER_PATTERNS) {
      if (re.test(p)) {
        matched = true;
        break;
      }
    }
    if (!matched) kept.push(p);
  }
  return kept.join('\n\n').trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Tracking URL strip
// ────────────────────────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/g;
const TRACKING_PARAM_RE = /\b(utm_[a-z_]+|gclid|fbclid|mc_eid|mc_cid|hsCtaTracking|wickedid)\b/i;

/**
 * For each URL in the body, if it carries any tracking param, replace the
 * URL with `https://<host>/`. URLs without tracking params are left alone.
 * Returns the new body + the count of substitutions.
 */
export function stripTrackingUrls(body: string): { text: string; replaced: number } {
  let replaced = 0;
  const text = body.replace(URL_RE, (url) => {
    if (!TRACKING_PARAM_RE.test(url)) return url;
    try {
      const u = new URL(url);
      replaced += 1;
      return `${u.protocol}//${u.host}/`;
    } catch {
      return url;
    }
  });
  return { text, replaced };
}
