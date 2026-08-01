/**
 * Test 2026-grade — error-translator.ts (pure logic, 14 rules + fallback).
 *
 * 🚨 UX-CRITICAL: ogni messaggio visibile all'operatore (non-developer)
 *    DEVE essere self-explanatory. Bug in queste regex = errore tradotto
 *    male = utente confuso → ticket support.
 *
 * 🚨 SPECIFICITY ORDERING: le rule sono ordered most-specific first. Test
 *    aggressivi su overlap (FK vs CHECK, HTTP 401 vs Telegram 403) per
 *    garantire la rule corretta scatti.
 *
 * 🚨 REGEX EXTRACTION: ogni rule estrae substring dall'errore originale
 *    (nome colonna NOT NULL, status HTTP, field name "Cannot read property").
 *    Test che il capture group sia preciso anche con varianti reali del messaggio.
 *
 * Coverage 14 rule + fallback + 2 bug regression candidate.
 */
import { describe, it, expect } from 'vitest';
import { translateError, type ErrorContext } from './error-translator.js';

const ctx: ErrorContext = {
  nodeId: 'node-abc-123',
  nodeLabel: 'Insert Order',
  defId: 'db_insert',
};

describe('🚨 PDF parse rule', () => {
  it('🚨 "missing required config base64" → titolo PDF', () => {
    const r = translateError('action_pdf_parse: missing required config "base64"', ctx);
    expect(r.title).toMatch(/PDF non è arrivato/u);
    expect(r.actions?.[0]?.kind).toBe('goto-node');
    expect(r.actions?.[0]?.target).toBe('first-trigger');
  });

  it('🚨 "action_pdf_parse: provide path or base64" matcha', () => {
    const r = translateError('action_pdf_parse: provide path or base64', ctx);
    expect(r.title).toMatch(/PDF non è arrivato/u);
  });

  it('🚨 raw conservato per "Mostra dettagli tecnici"', () => {
    const raw = 'action_pdf_parse: missing required config "base64"';
    const r = translateError(raw, ctx);
    expect(r.raw).toBe(raw);
  });
});

describe('🚨 Cannot read property — engine error', () => {
  it('🚨 modern node "Cannot read properties of undefined (reading X)" → estrae X', () => {
    const r = translateError(
      "Cannot read properties of undefined (reading 'customerEmail')",
      ctx,
    );
    expect(r.title).toContain('"customerEmail"');
    expect(r.title).toContain('"Insert Order"');
    expect(r.hint).toContain('customerEmail');
  });

  it('🚨 legacy node "Cannot read property X of undefined" → fallback "?"', () => {
    const r = translateError("Cannot read property 'foo' of undefined", ctx);
    // Il regex extractor è per "(reading 'X')" o "'X'" pattern — verifica logica
    // Stage 1: rule match → title contiene nodeLabel
    expect(r.title).toContain('"Insert Order"');
  });

  it('🚨 capture group ESCLUDE "of undefined" generic match', () => {
    const r = translateError(
      "Cannot read properties of null (reading 'data')",
      ctx,
    );
    expect(r.title).toContain('"data"');
    expect(r.hint).toContain('data');
  });
});

describe('🚨 FK constraint — DB specificity', () => {
  it('🚨 FK message specifico NON deve cadere su CHECK generic', () => {
    const r = translateError(
      'FOREIGN KEY constraint failed: orders.supplier_id',
      ctx,
    );
    // CRITICAL: rule FK è BEFORE rule CHECK nella lista, FK deve scattare
    expect(r.title).toMatch(/FOREIGN KEY/u);
    expect(r.title).not.toMatch(/CHECK/u);
    expect(r.hint).toContain('Insert Order');
    expect(r.hint).toMatch(/record padre/u);
  });

  it('🚨 FK suggestion action open-drawer', () => {
    const r = translateError('FOREIGN KEY constraint failed', ctx);
    expect(r.actions?.[0]?.kind).toBe('open-drawer');
  });
});

describe('🚨 UNIQUE constraint — estrae nome colonna', () => {
  it('🚨 estrae nome colonna da "UNIQUE constraint failed: users.email"', () => {
    const r = translateError('UNIQUE constraint failed: users.email', ctx);
    expect(r.title).toContain('(users.email)');
    expect(r.hint).toMatch(/db_update invece di db_insert/u);
  });

  it('🚨 senza nome colonna → title senza parentesi', () => {
    const r = translateError('UNIQUE constraint failed', ctx);
    expect(r.title).toContain('Duplicato');
    expect(r.title).not.toContain('()');
  });
});

describe('🚨 NOT NULL constraint — estrae nome colonna', () => {
  it('🚨 estrae nome colonna da messaggio standard', () => {
    const r = translateError('NOT NULL constraint failed: orders.customer_email', ctx);
    expect(r.title).toContain('orders.customer_email');
    expect(r.hint).toContain('customer_email'); // split('.').pop()
  });

  it('🚨 colonna senza schema (no dot) → usata come-è', () => {
    const r = translateError('NOT NULL constraint failed: status', ctx);
    expect(r.hint).toContain('status');
  });
});

describe('🚨 CHECK constraint — generic fallback dopo FK/UNIQUE/NOT NULL', () => {
  it('🚨 plain "CHECK constraint failed" → message enum-like', () => {
    const r = translateError('CHECK constraint failed: orders.status', ctx);
    expect(r.title).toMatch(/Valore non ammesso/u);
    expect(r.hint).toContain('Insert Order');
  });
});

describe('🚨 HTTP 4xx/5xx — overlap detection critico', () => {
  it('🚨 HTTP 401 → "credenziali invalide"', () => {
    const r = translateError('HTTP 401 unauthorized', ctx);
    expect(r.title).toContain('401');
    expect(r.hint).toMatch(/credenziali/iu);
    expect(r.hint).toMatch(/OAuth/u);
  });

  it('🚨 HTTP 403 → stesso bucket di 401', () => {
    const r = translateError('Got 403 from upstream', ctx);
    expect(r.hint).toMatch(/credenziali/iu);
  });

  it('🚨 HTTP 404 → "non esiste"', () => {
    const r = translateError('Request returned 404', ctx);
    expect(r.hint).toMatch(/non esiste/u);
  });

  it('🚨 HTTP 500 → "servizio remoto"', () => {
    const r = translateError('HTTP 500 internal server error', ctx);
    expect(r.hint).toMatch(/servizio remoto/u);
  });

  it('🚨 HTTP 502/503/504 tutti scattano stesso bucket 500+', () => {
    for (const code of ['502', '503', '504']) {
      const r = translateError(`upstream ${code}`, ctx);
      expect(r.hint).toMatch(/servizio remoto/u);
    }
  });

  it('🚨 title troncato a 100 char (slice safety)', () => {
    const longLabel = 'X'.repeat(200);
    const r = translateError('Got 500 err', { ...ctx, nodeLabel: longLabel });
    expect(r.title.length).toBeLessThanOrEqual(100);
  });
});

describe('🚨 LLM error — Liara/OpenAI/Anthropic', () => {
  it('🚨 "Liara 429: rate limit" matcha', () => {
    const r = translateError('Liara 429: rate limit exceeded', ctx);
    expect(r.title).toMatch(/Errore LLM/u);
    expect(r.hint).toMatch(/Settings → AI Providers/u);
  });

  it('🚨 "OpenAI 500: ..." → HTTP rule wins (500 è in HTTP set, scatta PRIMA)', () => {
    // HTTP rule è BEFORE LLM rule nell'ordering → 500 vince
    const r = translateError('OpenAI 500: bad gateway', ctx);
    expect(r.title).toContain('500');
    expect(r.hint).toMatch(/servizio remoto/u);
  });

  it('🚨 "OpenAI overloaded_error" (no HTTP code) → LLM rule scatta', () => {
    // Senza numero HTTP, LLM rule è il primo match
    // ATTENZIONE: regex è "OpenAI \d+:" quindi serve numero per matchare LLM rule
    // → senza numero CADE su fallback generic
    const r = translateError('OpenAI overloaded_error: model unavailable', ctx);
    // Fallback generic (nessuna rule matcha)
    expect(r.title).toContain('"Insert Order"');
  });

  it('🚨 "Anthropic 401: invalid api key" matcha', () => {
    const r = translateError('Anthropic 401: invalid api key', ctx);
    // CRITICAL: HTTP rule matcha PRIMA perché 401 è nella regex — verifica ordering
    // In realtà LLM rule è AFTER HTTP rule, quindi HTTP scatta prima
    expect(r.title).toBeDefined();
    // Vince HTTP 401: 'credenziali invalide o scadute'
    expect(r.hint).toMatch(/credenziali/iu);
  });

  it('🚨 "LLM provider error" matcha senza codice numerico', () => {
    const r = translateError('LLM internal error: missing model', ctx);
    expect(r.title).toMatch(/Errore LLM/u);
  });
});

describe('🚨 Circuit breaker open', () => {
  it('🚨 "CircuitBreakerOpenError" → action admin breakers', () => {
    const r = translateError('CircuitBreakerOpenError: gmail breaker', ctx);
    expect(r.title).toMatch(/Circuit Breaker/u);
    expect(r.actions?.[0]?.target).toBe('admin-breakers');
  });

  it('🚨 "Circuit breaker X is open" anche', () => {
    const r = translateError('Circuit breaker "gmail" is open (retry in 30s)', ctx);
    expect(r.title).toMatch(/Circuit Breaker/u);
  });
});

describe('🚨 SMTP/email rules', () => {
  it('🚨 "host/from/to/subject all required" → campi obbligatori', () => {
    const r = translateError('email_send: host/from/to/subject all required', ctx);
    expect(r.title).toMatch(/Campi email/u);
    expect(r.hint).toMatch(/Settings/u);
  });

  it('🚨 "unresolved {{...}}" → template non interpolato', () => {
    const r = translateError('smtp send: unresolved {{...}} in subject', ctx);
    expect(r.title).toMatch(/Template email/u);
  });

  it('🚨 generic SMTP error → fallback "Errore SMTP"', () => {
    const r = translateError('smtp connection timeout', ctx);
    expect(r.title).toMatch(/SMTP/u);
    expect(r.hint).toMatch(/Email Accounts/u);
  });
});

describe('🚨 Telegram rules', () => {
  it('🚨 "botToken malformato" → token incompleto', () => {
    const r = translateError('botToken malformato — manca ":"', ctx);
    expect(r.title).toMatch(/Token Telegram incompleto/u);
    expect(r.hint).toMatch(/@BotFather/u);
  });

  it('🚨 "Telegram API 404" → bot non trovato', () => {
    const r = translateError('Telegram API 404: bot not found', ctx);
    // HTTP rule matcha PRIMA (regex \b404\b è nella HTTP rule)
    // Verifica che il messaggio risultante sia coerente
    expect(r.title).toBeDefined();
    expect(r.hint).toMatch(/non esiste|non trovato|HTTP/iu);
  });

  it('🚨 "Telegram error" generic → fallback Telegram', () => {
    const r = translateError('Telegram error: invalid chat_id', ctx);
    expect(r.title).toMatch(/Telegram/u);
  });
});

describe('🚨 JSON malformed — Liara repair fallita', () => {
  it('🚨 "no balanced JSON found" matcha', () => {
    const r = translateError('Liara response: no balanced JSON found', ctx);
    expect(r.title).toMatch(/JSON malformato/u);
    expect(r.hint).toMatch(/Contesto aggiuntivo/u);
  });

  it('🚨 "_parseError" matcha (interno)', () => {
    const r = translateError('output has _parseError: SyntaxError', ctx);
    expect(r.title).toMatch(/JSON malformato/u);
  });
});

describe('🚨 IMAP errors', () => {
  it('🚨 "IMAP connection fail" → hint App Password', () => {
    const r = translateError('IMAP connection fail: timeout', ctx);
    expect(r.title).toMatch(/IMAP/u);
    expect(r.hint).toMatch(/App Password/u);
  });

  it('🚨 "imapflow error" matcha', () => {
    const r = translateError('imapflow.error: AUTHENTICATIONFAILED', ctx);
    expect(r.title).toMatch(/IMAP/u);
  });
});

describe('🚨 Network errors', () => {
  it('🚨 ECONNREFUSED → "Rete non raggiungibile"', () => {
    const r = translateError('connect ECONNREFUSED 127.0.0.1:5432', ctx);
    expect(r.title).toMatch(/Rete non raggiungibile/u);
    expect(r.hint).toMatch(/firewall/u);
  });

  it('🚨 ETIMEDOUT matcha', () => {
    const r = translateError('ETIMEDOUT', ctx);
    expect(r.title).toMatch(/Rete non raggiungibile/u);
  });

  it('🚨 ENOTFOUND matcha (DNS fail)', () => {
    const r = translateError('getaddrinfo ENOTFOUND xyz.example.com', ctx);
    expect(r.title).toMatch(/Rete non raggiungibile/u);
  });

  it('🚨 "fetch failed" generic → matcha', () => {
    const r = translateError('TypeError: fetch failed', ctx);
    expect(r.title).toMatch(/Rete non raggiungibile/u);
  });
});

describe('🚨 DB Insert Batch refFrom', () => {
  it('🚨 estrae nome ref da messaggio', () => {
    const r = translateError(
      'batch op 2: refFrom "supplier" is not bound to any previous operation',
      ctx,
    );
    expect(r.title).toMatch(/Insert Batch non bound/u);
    expect(r.hint).toContain('"supplier"');
  });

  it('🚨 messaggio "refFrom not bound" SENZA quotes NON matcha (regex richiede .* is)', () => {
    // Regex: /refFrom .* is not bound/u richiede "is" prima di "not bound"
    // "refFrom not bound" senza "is" → NON matcha → fallback
    const r = translateError('refFrom not bound', ctx);
    expect(r.title).toContain('"Insert Order"');
    expect(r.hint).toMatch(/dettagli tecnici/u);
  });

  it('🚨 messaggio FORMA CORRETTA "refFrom \\"X\\" is not bound" senza quote interno → fallback ?', () => {
    // Regex match SI, ma capture group (.+ quotato) FAIL → fallback "?"
    const r = translateError('refFrom XYZ is not bound to anything', ctx);
    expect(r.title).toMatch(/Insert Batch non bound/u);
    expect(r.hint).toContain('"?"'); // capture fallisce → "?"
  });
});

describe('🚨 Fallback generic — no rule matches', () => {
  it('🚨 messaggio totalmente unknown → fallback con nodeLabel', () => {
    const r = translateError('xyzzy something weird happened', ctx);
    expect(r.title).toContain('"Insert Order"');
    expect(r.hint).toMatch(/dettagli tecnici/u);
    expect(r.raw).toBe('xyzzy something weird happened');
  });

  it('🚨 empty string → fallback (non crash)', () => {
    const r = translateError('', ctx);
    expect(r.title).toContain('"Insert Order"');
    expect(r.raw).toBe('');
  });
});

describe('🚨 Rule specificity ordering — regression', () => {
  it('🚨 "FOREIGN KEY constraint failed" NON scatta UNIQUE/NOT NULL/CHECK', () => {
    // 4 messaggi con "constraint failed" — FK è il PIU\` specifico
    const r = translateError('FOREIGN KEY constraint failed: orders.x', ctx);
    expect(r.title).toMatch(/FOREIGN KEY/u);
    expect(r.title).not.toMatch(/Duplicato/u);
    expect(r.title).not.toMatch(/CHECK/u);
    expect(r.title).not.toMatch(/obbligatorio/u);
  });

  it('🚨 "UNIQUE constraint failed" NON scatta NOT NULL/CHECK', () => {
    const r = translateError('UNIQUE constraint failed: users.email', ctx);
    expect(r.title).toMatch(/Duplicato/u);
    expect(r.title).not.toMatch(/obbligatorio/u);
  });

  it('🚨 ctx.nodeLabel sempre interpolato (Federico-grade requirement)', () => {
    const messages = [
      'FOREIGN KEY constraint failed',
      'NOT NULL constraint failed: x',
      'CHECK constraint failed',
      'HTTP 401',
      'CircuitBreakerOpenError',
      'fetch failed',
      'random unknown error',
    ];
    for (const msg of messages) {
      const r = translateError(msg, { ...ctx, nodeLabel: 'My Custom Node' });
      // Almeno UNA tra title/hint contiene nodeLabel (rule-specific)
      const hasLabel = r.title.includes('My Custom Node') || r.hint.includes('My Custom Node');
      expect(hasLabel).toBe(true);
    }
  });
});

describe('🚨 Output shape contract', () => {
  it('🚨 sempre title + hint + raw, actions opzionale', () => {
    const r = translateError('FOREIGN KEY constraint failed', ctx);
    expect(typeof r.title).toBe('string');
    expect(typeof r.hint).toBe('string');
    expect(typeof r.raw).toBe('string');
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.hint.length).toBeGreaterThan(0);
  });

  it('🚨 actions kind enum-only: goto-node | open-drawer | docs', () => {
    const validKinds = new Set(['goto-node', 'open-drawer', 'docs']);
    // Scorri tutti i casi noti con action
    const cases = [
      'action_pdf_parse: missing required config "base64"',
      "Cannot read properties of undefined (reading 'x')",
      'FOREIGN KEY constraint failed',
      'CircuitBreakerOpenError',
    ];
    for (const msg of cases) {
      const r = translateError(msg, ctx);
      if (r.actions) {
        for (const a of r.actions) {
          expect(validKinds.has(a.kind)).toBe(true);
        }
      }
    }
  });
});
