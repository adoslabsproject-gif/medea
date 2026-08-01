/**
 * Classificazione PURA degli errori di CONNETTIVITÀ verso un database (incluso il
 * tunnel SSH). Un timeout/handshake-fail/host-unreachable è un fallimento INFRA a
 * monte → deve diventare HTTP 503 con un messaggio CHIARO, non un 400 muto che
 * congela la UI per 15s (bug 2026-06-17: NHA dietro tunnel SSH irraggiungibile →
 * introspect/lettura tabelle/export davano 400 silenzioso senza spinner).
 *
 * Nessun I/O → testabile in isolamento con i messaggi d'errore REALI (ssh2, pg, net).
 */

export interface DbConnClassification {
  /** True se è un fallimento di connettività (→ 503 + messaggio, non 400). */
  unreachable: boolean;
  /** Messaggio utente chiaro (IT). Vuoto se non è un errore di connettività. */
  userMessage: string;
}

// Pattern → messaggio. Ordine: dal più specifico al più generico.
const PATTERNS: { re: RegExp; msg: string }[] = [
  {
    re: /timed out while waiting for handshake/i, // ssh2: tunnel SSH
    msg: 'Il tunnel SSH non risponde (handshake in timeout): il server remoto è irraggiungibile o sta bloccando la connessione (es. fail2ban che ha bannato l\'IP). Verifica che sia attivo e raggiungibile, poi riprova.',
  },
  {
    re: /all configured authentication methods failed|authentication.*failed|auth.*method/i, // ssh auth
    msg: 'Autenticazione del tunnel SSH fallita: la chiave o le credenziali del tunnel non sono valide. Controlla le impostazioni di connessione.',
  },
  {
    re: /\bECONNREFUSED\b|connection refused/i,
    msg: 'Connessione rifiutata dal database remoto: il servizio è spento o la porta non è in ascolto.',
  },
  {
    re: /\b(EHOSTUNREACH|ENETUNREACH)\b|host is unreachable|network is unreachable/i,
    msg: 'Host del database remoto irraggiungibile: problema di rete o firewall sul server remoto.',
  },
  {
    re: /\b(ENOTFOUND|EAI_AGAIN)\b|getaddrinfo/i,
    msg: 'Indirizzo del database remoto non risolvibile (DNS): controlla hostname/host del tunnel.',
  },
  {
    re: /connection (terminated|lost|closed)|socket hang ?up|socket disconnected|read ECONNRESET|\bECONNRESET\b/i,
    msg: 'Connessione al database remoto interrotta. Riprova; se persiste, verifica il server remoto.',
  },
  {
    re: /\bETIMEDOUT\b|connect(ion)?\s*time(d)?\s*out|timed? out|handshake timeout/i,
    msg: 'Timeout di connessione al database remoto: il server non risponde entro i tempi. Verifica che sia attivo e raggiungibile, poi riprova.',
  },
];

/** Classifica un errore: connettività (→ 503 + msg chiaro) oppure no. Non lancia. */
export function classifyDbConnectionError(err: unknown): DbConnClassification {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const p of PATTERNS) {
    if (p.re.test(text)) return { unreachable: true, userMessage: p.msg };
  }
  return { unreachable: false, userMessage: '' };
}
