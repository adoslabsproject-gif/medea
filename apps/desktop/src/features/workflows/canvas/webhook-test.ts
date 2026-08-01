/**
 * Bussare al proprio webhook, come farebbe chi lo userà.
 *
 * Un nodo webhook si configura al buio: si sceglie come autenticare, si
 * salva, e si scopre se funziona quando il servizio esterno prova a
 * chiamarlo — cioè quando sbagliare costa. Da qui si prova prima.
 *
 * ───── La firma ─────
 *
 * Con `hmac-signature` il motore rifiuta chi non firma, e firmare a mano
 * significa aprire un terminale e comporre uno `openssl dgst`. Qui la firma
 * si calcola con lo stesso identico contratto che il motore verifica —
 * segreto, algoritmo, nome dell'intestazione, e il formato `ts.body` quando
 * c'è una marca temporale.
 *
 * Se questo calcolo diverge da quello del motore, il tester direbbe che
 * funziona quando non funziona: è il tipo di strumento che è peggio di
 * niente se è approssimativo.
 */

/** Come il motore chiama l'intestazione della firma, se non si dice altro. */
const HEADER_PREDEFINITO = 'x-flowforge-signature';
const ALGORITMI = ['sha256', 'sha1', 'sha512'] as const;

export type Algoritmo = (typeof ALGORITMI)[number];

export interface ConfigWebhook {
  authMode?: string;
  hmacSecret?: string;
  authSecret?: string;
  hmacHeader?: string;
  hmacAlgo?: string;
  hmacTimestampHeader?: string;
  hmacSignedPayloadFormat?: string;
}

/** Il valore di un campo, se è testo e non è vuoto. */
function testo(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export interface PianoFirma {
  header: string;
  algo: Algoritmo;
  secret: string;
  /** Il nome dell'intestazione con la marca temporale, se prevista. */
  timestampHeader?: string;
  /** Cosa si firma: il corpo, oppure `<marca>.<corpo>`. */
  format: 'body' | 'ts.body';
}

/**
 * Come va firmata una chiamata a questo nodo, se va firmata.
 *
 * Restituisce niente quando il nodo non usa la firma: le altre modalità si
 * provano senza calcolare niente.
 */
export function pianoFirma(config: Record<string, unknown>): PianoFirma | null {
  const c = config as ConfigWebhook;
  if (c.authMode !== 'hmac-signature') return null;

  // Il motore accetta due forme, nuova e vecchia: `hmacSecret` vince, e
  // `authSecret` resta per i workflow scritti prima.
  const secret = testo(c.hmacSecret) ?? testo(c.authSecret);
  if (!secret) return null;

  const algo = ALGORITMI.find((a) => a === c.hmacAlgo) ?? 'sha256';
  const tsHeader = testo(c.hmacTimestampHeader);

  return {
    header: testo(c.hmacHeader)?.toLowerCase() ?? HEADER_PREDEFINITO,
    algo,
    secret,
    ...(tsHeader ? { timestampHeader: tsHeader } : {}),
    // `ts.body` è il formato di Stripe ed è quello che il motore usa quando
    // c'è una marca temporale; `body` è quello di GitHub.
    format: tsHeader && c.hmacSignedPayloadFormat !== 'body' ? 'ts.body' : 'body',
  };
}

/** Il nome dell'algoritmo come lo chiama la Web Crypto. */
function nomeWebCrypto(algo: Algoritmo): string {
  return algo === 'sha1' ? 'SHA-1' : algo === 'sha512' ? 'SHA-512' : 'SHA-256';
}

/** Da byte a esadecimale, che è come il motore si aspetta la firma. */
function esadecimale(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Le intestazioni da mandare, firma compresa.
 *
 * La marca temporale è quella di adesso: il motore rifiuta quelle vecchie —
 * è la protezione contro chi rigioca una chiamata catturata — e usarne una
 * fissa farebbe fallire la prova per il motivo sbagliato.
 */
export async function intestazioniFirmate(
  piano: PianoFirma,
  body: string,
  adesso: number = Date.now(),
): Promise<Record<string, string>> {
  const ts = Math.floor(adesso / 1000).toString();
  const daFirmare = piano.format === 'ts.body' ? `${ts}.${body}` : body;

  const chiave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(piano.secret),
    { name: 'HMAC', hash: nomeWebCrypto(piano.algo) },
    false,
    ['sign'],
  );
  const firma = await crypto.subtle.sign('HMAC', chiave, new TextEncoder().encode(daFirmare));

  return {
    [piano.header]: esadecimale(firma),
    ...(piano.timestampHeader ? { [piano.timestampHeader]: ts } : {}),
  };
}

/** Cosa serve per autenticare, quando non è una firma. */
export function comeAutenticare(config: Record<string, unknown>): string | null {
  const c = config as ConfigWebhook;
  switch (c.authMode) {
    case 'header-token':
      return 'Il token viaggia nell’indirizzo: la prova lo include già.';
    case 'basic-auth':
      return 'Serve utente e password: aggiungili nelle intestazioni qui sotto.';
    case 'jwt':
      return 'Serve un token JWT valido nell’intestazione Authorization.';
    case 'hmac-signature':
      return null;
    default:
      return 'Nessuna autenticazione oltre al token nell’indirizzo.';
  }
}
