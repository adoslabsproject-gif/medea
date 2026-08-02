/**
 * Error translator — wraps cryptic engine/executor errors with a
 * user-friendly Italian message + actionable hint.
 *
 * USAGE
 *   const friendly = translateError(rawMessage, { nodeId, nodeLabel, defId });
 *   // → { title, hint, actions?: [{label, kind, target?}] }
 *
 * DESIGN
 *   • Pure function — no state, easy to unit-test
 *   • Patterns ordered by specificity (longest/most-specific FIRST so
 *     "FOREIGN KEY constraint failed: orders.supplier_id" doesn't fall
 *     through to the generic "constraint" matcher)
 *   • Each translation MUST tell the user what to DO. No generic
 *     "an error occurred" — that's just noise.
 *   • When the error names a specific upstream node, emit a `goto-node`
 *     action so the RunInspector can render a "Apri nodo a monte" button.
 *
 * Federico-grade rule: every error message visible to the operator
 * (non-developer) MUST be self-explanatory. If they can't fix the issue
 * by reading the message, the message is wrong.
 */

export interface TranslatedError {
  /** Short title — 1 line, what went wrong in plain language. */
  title: string;
  /** Longer hint — 1-2 sentences, what to DO to fix it. */
  hint: string;
  /** Suggested actions surfaced in the RunInspector. */
  actions?: { label: string; kind: 'goto-node' | 'open-drawer' | 'docs'; target?: string }[];
  /** Original raw message — kept for "Mostra dettagli tecnici". */
  raw: string;
}

export interface ErrorContext {
  nodeId: string;
  nodeLabel: string;
  defId: string;
}

interface Rule {
  match: RegExp | ((msg: string, ctx: ErrorContext) => boolean);
  translate: (msg: string, ctx: ErrorContext) => Omit<TranslatedError, 'raw'>;
}

const RULES: Rule[] = [
  // ── PDF extract — missing input ──────────────────────────────────────
  {
    match:
      /pdf.*serve.*config\.(path|base64)|missing required config "base64"|action_pdf_parse: provide/u,
    translate: (_msg, _ctx) => ({
      title: 'Il PDF non è arrivato a questo nodo',
      hint: "Il nodo PDF Parse aspetta un PDF (base64 o path). Verifica che il nodo a monte (di solito Email IMAP o File Read) abbia prodotto un allegato. Se stai testando manualmente, pinna l'output del trigger con un base64 di esempio.",
      actions: [
        {
          label: '↑ Apri trigger e configura Mock Data',
          kind: 'goto-node',
          target: 'first-trigger',
        },
      ],
    }),
  },

  // ── Engine — node never produced output because upstream errored ─────
  {
    match: /Cannot read propert(ies|y) ('?[\w_]+'?|of undefined|of null)/u,
    translate: (msg, ctx) => {
      // Cover both: "of undefined (reading 'X')", "of null (reading 'X')", e shortcut "'X'"
      const field =
        /Cannot read propert(?:y|ies) (?:of (?:undefined|null) \(reading '([^']+)'\)|'([^']+)')/u.exec(
          msg,
        );
      const fieldName = field ? (field[1] ?? field[2] ?? '?') : '?';
      return {
        title: `Il nodo "${ctx.nodeLabel}" cerca di leggere il campo "${fieldName}" ma il dato non è arrivato`,
        hint: `Una delle espressioni in questo nodo (probabilmente {{$node.X.json.${fieldName}}}) punta a un campo che il nodo a monte NON ha prodotto. Controlla l'output del nodo upstream nel Run Inspector e verifica che esista quel campo.`,
        actions: [{ label: '🔍 Mostra output dei nodi a monte', kind: 'open-drawer' }],
      };
    },
  },

  // ── DB — FK constraint failed ────────────────────────────────────────
  {
    match: /FOREIGN KEY constraint failed/u,
    translate: (_msg, ctx) => ({
      title: 'Riferimento DB non valido (FOREIGN KEY)',
      hint: `Il nodo "${ctx.nodeLabel}" tenta di inserire un record che fa riferimento (FK) a una riga che NON esiste nella tabella collegata. Tipico: order_lines.order_id punta a un orders.id mai creato. Verifica l'ordine di esecuzione e che il record padre venga inserito PRIMA.`,
      actions: [
        { label: '↑ Controlla il nodo che inserisce il record padre', kind: 'open-drawer' },
      ],
    }),
  },

  // ── DB — UNIQUE constraint (duplicate) ───────────────────────────────
  {
    match: /UNIQUE constraint failed/u,
    translate: (msg, _ctx) => {
      const col = /UNIQUE constraint failed:\s*(\S+)/u.exec(msg);
      return {
        title: `Duplicato: la riga esiste già ${col ? `(${col[1]})` : ''}`,
        hint: 'La tabella ha un vincolo di unicità su una o più colonne, e stai tentando di inserire un valore già presente. Possibili fix: (1) usa db_update invece di db_insert; (2) cambia il valore della colonna duplicata; (3) controlla il dedup logico nel workflow (es. processed_emails per evitare doppio processing).',
      };
    },
  },

  // ── DB — NOT NULL constraint ─────────────────────────────────────────
  {
    match: /NOT NULL constraint failed:\s*(\S+)/u,
    translate: (msg, ctx) => {
      const col = /NOT NULL constraint failed:\s*(\S+)/u.exec(msg);
      return {
        title: `Campo obbligatorio mancante: ${col ? col[1] : 'sconosciuto'}`,
        hint: `Il nodo "${ctx.nodeLabel}" sta inserendo una riga senza valorizzare un campo NOT NULL. Verifica che l'espressione che produce quel valore (es. {{$node.X.json.${col?.[1]?.split('.').pop() ?? 'campo'}}}) non sia vuota a runtime.`,
      };
    },
  },

  // ── CHECK constraint (enum-like) ─────────────────────────────────────
  {
    match: /CHECK constraint failed/u,
    translate: (_msg, ctx) => ({
      title: 'Valore non ammesso (CHECK)',
      hint: `Il nodo "${ctx.nodeLabel}" sta inserendo un valore non incluso nella whitelist definita dalla tabella. Es. orders.status accetta solo 'created'/'sent_to_supplier'/'confirmed'/... — controlla che l'espressione produca uno dei valori validi.`,
    }),
  },

  // ── HTTP — 4xx/5xx ───────────────────────────────────────────────────
  {
    match: /\b(401|403|404|500|502|503|504)\b/u,
    translate: (msg, ctx) => {
      const status = /\b(\d{3})\b/u.exec(msg);
      const code = status ? Number(status[1]) : 0;
      let title = `HTTP ${status?.[1] ?? '?'} dal servizio chiamato da "${ctx.nodeLabel}"`;
      let hint = '';
      if (code === 401 || code === 403)
        hint =
          'Credenziali invalide o scadute. Verifica API key / token nel drawer del nodo. Se è un OAuth, ri-autorizza.';
      else if (code === 404)
        hint =
          "L'URL o la risorsa chiamata non esiste. Verifica il path e gli ID dinamici nelle espressioni.";
      else if (code >= 500)
        hint =
          'Il servizio remoto ha problemi. Riprova fra qualche minuto. Se persiste, controlla lo status page del provider.';
      else hint = 'Verifica i parametri inviati al servizio.';
      title = title.slice(0, 100);
      return { title, hint };
    },
  },

  // ── LLM — Liara/OpenAI generic ───────────────────────────────────────
  {
    match: /Liara \d+:|OpenAI \d+:|Anthropic \d+:|LLM .* error/u,
    translate: (_msg, ctx) => ({
      title: `Errore LLM nel nodo "${ctx.nodeLabel}"`,
      hint: 'Il provider LLM ha rifiutato la richiesta. Tipiche cause: API key scaduta, rate limit, prompt troppo lungo, modello non disponibile. Verifica in Settings → AI Providers che la chiave sia valida.',
    }),
  },

  // ── Circuit breaker open ─────────────────────────────────────────────
  {
    match: /CircuitBreakerOpenError|Circuit breaker .* is open/u,
    translate: (_msg, ctx) => ({
      title: 'Servizio temporaneamente disabilitato (Circuit Breaker)',
      hint: `Il servizio chiamato da "${ctx.nodeLabel}" ha fallito troppe volte di seguito e il circuit breaker è scattato per proteggere il sistema. Riprova fra 1 minuto. Se persiste, controlla il pannello Admin → Circuit Breakers.`,
      actions: [
        { label: '⚡ Apri Circuit Breakers (admin)', kind: 'goto-node', target: 'admin-breakers' },
      ],
    }),
  },

  // ── Email SMTP errors ────────────────────────────────────────────────
  {
    match: /smtp|SMTP|host\/from\/to\/subject all required/u,
    translate: (msg, ctx) => {
      if (msg.includes('all required')) {
        return {
          title: 'Campi email obbligatori mancanti',
          hint: `Il nodo "${ctx.nodeLabel}" richiede host SMTP, from, to e subject valorizzati. Se hai selezionato un Email Account in Settings, host/from sono ereditati — verifica che to e subject NON siano stringhe vuote a runtime.`,
        };
      }
      if (/unresolved \{\{\.{3}\}\}|unresolved.*template/u.test(msg)) {
        return {
          title: 'Template email non interpolato',
          hint: `Il subject o body contiene {{...}} ancora visibili — significa che un nodo a monte non ha prodotto il dato atteso. Controlla l'output dei nodi precedenti.`,
        };
      }
      return {
        title: `Errore SMTP nel nodo "${ctx.nodeLabel}"`,
        hint: 'Verifica le credenziali SMTP in Settings → Email Accounts. Prova "Test SMTP" per diagnosticare.',
      };
    },
  },

  // ── Telegram ─────────────────────────────────────────────────────────
  {
    match: /Telegram API \d+|botToken malformato|Telegram error/u,
    translate: (msg, ctx) => {
      if (msg.includes('malformato')) {
        return {
          title: 'Token Telegram incompleto',
          hint: 'Hai incollato solo metà del token? Il formato corretto è <bot_id>:<random> (es. "7846123456:AAH9pk91…"). Apri @BotFather → /mybots → seleziona il bot → "API Token" → copia TUTTO.',
        };
      }
      if (msg.includes('404')) {
        return {
          title: 'Bot Telegram non trovato (404)',
          hint: 'Il bot non esiste o il token è errato. Verifica con @BotFather che il bot sia attivo.',
        };
      }
      if (msg.includes('403')) {
        return {
          title: "Bot Telegram bloccato dall'utente",
          hint: "L'utente o il gruppo ha bloccato il bot, oppure il bot non è membro del gruppo. Aggiungi il bot al gruppo o sblocca dal client Telegram.",
        };
      }
      return {
        title: `Errore Telegram nel nodo "${ctx.nodeLabel}"`,
        hint: 'Verifica botToken (formato <id>:<random>) e chatId nel drawer del nodo.',
      };
    },
  },

  // ── JSON parse — Liara malformato ────────────────────────────────────
  {
    match: /no balanced JSON found|JSON parse failed|_parseError/u,
    translate: (_msg, ctx) => ({
      title: `Liara ha prodotto un JSON malformato`,
      hint: `Il nodo "${ctx.nodeLabel}" ha ricevuto da Liara una risposta che non era JSON valido (anche dopo il retry di repair). Possibili fix: (1) semplifica lo schema atteso, (2) aggiungi più esempi nel "Contesto aggiuntivo", (3) prova con un altro LLM provider (Anthropic/OpenAI) come fallback.`,
    }),
  },

  // ── IMAP connection ──────────────────────────────────────────────────
  {
    match: /IMAP .* fail|imapflow.*error/u,
    translate: (_msg, _ctx) => ({
      title: 'Connessione IMAP fallita',
      hint: 'Verifica host, porta, credenziali in Settings → Email Accounts → Test IMAP. Per Gmail serve "App Password" (non la password account); per altri provider TLS=993 di solito.',
    }),
  },

  // ── Network / fetch failed ───────────────────────────────────────────
  {
    match: /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/u,
    translate: (_msg, ctx) => ({
      title: `Rete non raggiungibile dal nodo "${ctx.nodeLabel}"`,
      hint: "Il server FlowForge non riesce a raggiungere l'endpoint esterno. Verifica connettività, firewall, e che l'URL sia corretto e pubblicamente accessibile.",
    }),
  },

  // ── Batch transaction — refFrom not bound ────────────────────────────
  {
    match: /refFrom .* is not bound/u,
    translate: (msg, _ctx) => {
      const m = /refFrom "([^"]+)"/u.exec(msg);
      return {
        title: 'Riferimento DB Insert Batch non bound',
        hint: `Il nodo DB Insert Batch tenta di usare "${m?.[1] ?? '?'}" come FK ai children ma nessuna operazione precedente l'ha bindato. Verifica che la prima operazione "insert" abbia il campo "as" valorizzato con lo stesso nome.`,
      };
    },
  },
];

/**
 * Translate a raw error message into a user-friendly form.
 * Returns null if no rule matches — caller can fall back to showing
 * the raw message (preferably in a collapsed "tech details" section).
 */
export function translateError(raw: string, ctx: ErrorContext): TranslatedError {
  for (const rule of RULES) {
    const matched = typeof rule.match === 'function' ? rule.match(raw, ctx) : rule.match.test(raw);
    if (matched) {
      const tx = rule.translate(raw, ctx);
      return { ...tx, raw };
    }
  }
  // No specific rule — emit a generic but still actionable message.
  return {
    title: `Errore nel nodo "${ctx.nodeLabel}"`,
    hint: 'Apri i dettagli tecnici sotto per il messaggio originale. Se è ricorrente, salva i dettagli e contatta il supporto.',
    raw,
  };
}
