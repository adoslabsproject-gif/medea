/**
 * Crypto utility nodes — primitive crittografiche enterprise, zero dipendenze
 * esterne (solo `node:crypto` built-in). Coprono i casi che in n8n sono sparsi
 * tra più nodi/community, qui unificati e "a prova di idiota": ogni opzione è in
 * UI con campi condizionali (showIf) e help inline.
 *
 *   - action_crypto : hash / HMAC / encode-decode / random bytes
 *   - action_uuid   : generatore ID (UUID v4/v7, ULID-like, short, nanoid-like)
 *   - action_jwt    : sign / verify / decode JWT (HS256/384/512)
 */
// 2026-06-06: NIENTE top-level `import 'node:crypto'` (server-only). Stessa
// convenzione di body-injector.ts / legal-archive.ts: stdlib viene importata
// dall'editor browser via barrel index.ts — un import top-level lo trascina
// nel bundle Vite e Rollup fallisce con "node:crypto not externalized".
// Lazy-import + accesso dentro gli executor (gia\` async).
type CryptoModule = typeof import('node:crypto');
let _crypto: CryptoModule | null = null;
async function nodeCrypto(): Promise<CryptoModule> {
  _crypto ??= await import('node:crypto');
  return _crypto;
}
import type { NodeModule, NodeExecutor } from '../types.js';

// ── helpers ──────────────────────────────────────────────────────────────
function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
/**
 * Parsing JSON difensivo per le parti di un JWT: un token in arrivo è
 * attacker-controlled, quindi NON deve mai far lanciare un'eccezione grezza.
 * Ritorna un Result esplicito invece di throw.
 */
function tryParseJson(s: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ════════════════════════════════════════════════════════════════════════
// action_crypto
// ════════════════════════════════════════════════════════════════════════
const cryptoExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const c = await nodeCrypto();
  const op = str(config.operation, 'hash');
  const algo = str(config.algorithm, 'sha256');
  const encoding = str(config.encoding, 'hex') === 'base64' ? 'base64' : 'hex';
  const value = config.value !== undefined && str(config.value) !== '' ? str(config.value) : str(input);

  let result: string;
  switch (op) {
    case 'hash':
      result = c.createHash(algo).update(value, 'utf8').digest(encoding);
      break;
    case 'hmac': {
      const key = str(config.key);
      if (!key) throw new Error('action_crypto: HMAC richiede una chiave segreta');
      result = c.createHmac(algo, key).update(value, 'utf8').digest(encoding);
      break;
    }
    case 'hmac-verify': {
      // Verifica firma webhook (Stripe/GitHub/...) a TEMPO COSTANTE: l'unico modo
      // sicuro. Confrontare l'HMAC con `==` nel workflow espone a timing attack →
      // questa operazione fa il confronto con timingSafeEqual internamente.
      const key = str(config.key);
      if (!key) throw new Error('action_crypto: HMAC verify richiede una chiave segreta');
      const expected = str(config.expected);
      const computed = c.createHmac(algo, key).update(value, 'utf8').digest();
      // L'atteso è codificato in hex/base64; un input malformato → buffer di
      // lunghezza diversa → timingSafeEqual salterebbe → confronto false (no throw).
      const expectedBuf = Buffer.from(expected, encoding as BufferEncoding);
      const valid = expectedBuf.length === computed.length && c.timingSafeEqual(expectedBuf, computed);
      return {
        output: { valid, result: computed.toString(encoding), operation: op, algorithm: algo, encoding },
        durationMs: Date.now() - startedAt,
      };
    }
    case 'encode':
      result = Buffer.from(value, 'utf8').toString(str(config.targetFormat, 'base64') as BufferEncoding);
      break;
    case 'decode':
      result = Buffer.from(value, str(config.sourceFormat, 'base64') as BufferEncoding).toString('utf8');
      break;
    case 'random': {
      const bytes = Math.min(Math.max(Number(config.bytes) || 32, 1), 1024);
      result = c.randomBytes(bytes).toString(encoding);
      break;
    }
    default:
      throw new Error(`action_crypto: operazione sconosciuta "${op}"`);
  }
  return { output: { result, operation: op, algorithm: algo, encoding }, durationMs: Date.now() - startedAt };
};

export const cryptoNode: NodeModule = {
  def: {
    id: 'action_crypto',
    type: 'action',
    label: 'Crypto',
    icon: 'lock',
    color: '#6366f1',
    description:
      'Coltellino svizzero crittografico enterprise basato esclusivamente su `node:crypto` (zero dipendenze ' +
      'esterne, nessuna superficie d\'attacco supply-chain) per tutte le operazioni di integrità, autenticazione ' +
      'e codifica dei dati nei workflow. Cinque operazioni in un solo nodo, ognuna selezionabile da dropdown con ' +
      'i parametri che appaiono/scompaiono in UI in base alla scelta (zero campi inutili a schermo): ' +
      '(1) HASH — digest a senso unico (SHA-256/384/512, SHA-1, MD5) di qualsiasi stringa o dell\'input del nodo, ' +
      'output in hex o base64, per fingerprint di documenti, idempotency-key deterministiche da payload, ETag, ' +
      'integrity check di file scaricati, deduplica per contenuto; ' +
      '(2) HMAC — hash autenticato con chiave segreta, per FIRMARE le proprie callback in uscita e calcolare ' +
      'digest autenticati; ' +
      '(2b) HMAC-VERIFY — verifica le firme dei webhook in arrivo (Stripe `Stripe-Signature`, GitHub ' +
      '`X-Hub-Signature-256`, Shopify, PayPal): calcola l\'HMAC del body e lo confronta con la firma attesa a ' +
      'TEMPO COSTANTE (timingSafeEqual) — l\'unico modo sicuro, perché un confronto con `==` nel workflow ' +
      'esporrebbe a timing attack; ritorna `{ valid: boolean }`; ' +
      '(3) ENCODE / (4) DECODE — conversione tra utf8 ↔ base64 / hex / base64url, per preparare Basic Auth ' +
      'headers, data-URI, payload binari in JSON, token; ' +
      '(5) RANDOM — bytes crittograficamente sicuri (CSPRNG) per generare secret, salt, nonce, token di reset, ' +
      'state OAuth anti-CSRF. ' +
      'Output: { result, operation, algorithm, encoding } — sempre osservabile e loggabile. ' +
      'Use case: verifica firma webhook Stripe prima di processare il pagamento (HMAC-SHA256 del raw body con ' +
      'il signing secret, confronto con l\'header); idempotency key SHA-256 del payload ordine per non creare ' +
      'fatture duplicate sui retry; generazione token di reset password sicuro (RANDOM 32 byte → hex); Basic ' +
      'Auth header (ENCODE "user:pass" → base64); fingerprint deduplica articoli scraped (HASH del titolo+url).',
    configFields: [
      {
        key: 'operation', label: 'Operazione', type: 'select', required: true,
        defaultValue: 'hash', options: ['hash', 'hmac', 'hmac-verify', 'encode', 'decode', 'random'],
        help: 'hash = digest one-way · hmac = firma con chiave · hmac-verify = verifica firma webhook (timing-safe) · encode/decode = base64/hex · random = bytes sicuri.',
      },
      {
        key: 'value', label: 'Valore in ingresso', type: 'expression', required: false, defaultValue: 'input',
        help: 'Testo o espressione da elaborare. Vuoto = usa l\'input del nodo.',
        showIf: { field: 'operation', in: ['hash', 'hmac', 'hmac-verify', 'encode', 'decode'] },
      },
      {
        key: 'algorithm', label: 'Algoritmo', type: 'select', required: false, defaultValue: 'sha256',
        options: ['sha256', 'sha512', 'sha384', 'sha1', 'md5'],
        help: 'SHA-256 raccomandato. MD5/SHA-1 solo per compatibilità legacy (NON sicuri per firme).',
        showIf: { field: 'operation', in: ['hash', 'hmac', 'hmac-verify'] },
      },
      {
        key: 'key', label: 'Chiave segreta (HMAC)', type: 'secret', required: false,
        help: 'Il signing secret (es. webhook secret di Stripe/GitHub). Mai committare in chiaro.',
        showIf: { field: 'operation', in: ['hmac', 'hmac-verify'] },
      },
      {
        key: 'expected', label: 'Firma attesa (da verificare)', type: 'expression', required: false,
        help: 'La firma ricevuta (es. header X-Hub-Signature-256 / Stripe-Signature) da confrontare a tempo costante. Nella stessa codifica dell\'output (hex/base64).',
        showIf: { field: 'operation', equals: 'hmac-verify' },
      },
      {
        key: 'encoding', label: 'Codifica output', type: 'select', required: false, defaultValue: 'hex',
        options: ['hex', 'base64'],
        showIf: { field: 'operation', in: ['hash', 'hmac', 'hmac-verify', 'random'] },
      },
      {
        key: 'targetFormat', label: 'Codifica destinazione', type: 'select', required: false, defaultValue: 'base64',
        options: ['base64', 'base64url', 'hex'],
        showIf: { field: 'operation', equals: 'encode' },
      },
      {
        key: 'sourceFormat', label: 'Codifica sorgente', type: 'select', required: false, defaultValue: 'base64',
        options: ['base64', 'base64url', 'hex'],
        showIf: { field: 'operation', equals: 'decode' },
      },
      {
        key: 'bytes', label: 'Numero di byte', type: 'number', required: false, defaultValue: '32',
        help: 'Quanti byte casuali generare (1-1024). 32 = 256 bit, standard per secret/token.',
        showIf: { field: 'operation', equals: 'random' },
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: cryptoExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_uuid
// ════════════════════════════════════════════════════════════════════════
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (ULID)
function ulidLikeFrom(randBytes: Buffer): string {
  const time = Date.now();
  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) { ts = ALPHABET[t % 32] + ts; t = Math.floor(t / 32); }
  let rand = '';
  for (let i = 0; i < 16; i += 1) rand += ALPHABET[randBytes[i]! % 32];
  return ts + rand;
}
const uuidExecutor: NodeExecutor = async (config) => {
  const startedAt = Date.now();
  const c = await nodeCrypto();
  const version = str(config.version, 'v4');
  const count = Math.min(Math.max(Number(config.count) || 1, 1), 10000);
  const upper = str(config.uppercase) === 'true';
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let id: string;
    switch (version) {
      case 'v7': {
        // UUIDv7: timestamp-ordered (48-bit ms) + random. Ordinabile per creazione.
        const ms = Date.now();
        const buf = c.randomBytes(16);
        buf.writeUIntBE(ms, 0, 6);
        buf[6] = (buf[6]! & 0x0f) | 0x70;
        buf[8] = (buf[8]! & 0x3f) | 0x80;
        const h = buf.toString('hex');
        id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        break;
      }
      case 'ulid': id = ulidLikeFrom(c.randomBytes(16)); break;
      case 'short': id = c.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10); break;
      case 'nanoid': id = c.randomBytes(16).toString('base64url').slice(0, 21); break;
      default: id = c.randomUUID();
    }
    ids.push(upper ? id.toUpperCase() : id.toLowerCase());
  }
  return { output: count === 1 ? { id: ids[0], ids } : { ids }, durationMs: Date.now() - startedAt };
};

export const uuidNode: NodeModule = {
  def: {
    id: 'action_uuid',
    type: 'action',
    label: 'Genera ID',
    icon: 'hash',
    color: '#06b6d4',
    description:
      'Generatore di identificatori unici enterprise per ogni esigenza di chiavi, correlation-id, idempotency e ' +
      'ordinamento, con cinque formati selezionabili da dropdown — perché non tutti gli ID sono uguali e usare ' +
      'quello giusto evita bug sottili e indici di database lenti: ' +
      '(1) UUID v4 — 122 bit casuali, lo standard universale per chiavi primarie, request-id, token opachi; ' +
      '(2) UUID v7 — timestamp-ordered (i primi 48 bit sono il millisecondo di creazione): ORDINABILE ' +
      'cronologicamente, ideale come PRIMARY KEY su Postgres/MySQL perché mantiene la località dell\'indice B-tree ' +
      '(gli insert vanno sempre "in coda" invece di frammentare l\'indice come fa il v4 random) → 2-3× più veloce ' +
      'su tabelle grandi; ' +
      '(3) ULID — 26 char Crockford-base32, lessicograficamente ordinabile e URL-safe, alternativa compatta al v7; ' +
      '(4) SHORT — 10 char, per slug/codici brevi human-shareable dove la collisione è tollerabile; ' +
      '(5) NANOID — 21 char URL-safe, compatto e collision-resistant per URL pubblici. ' +
      'Genera da 1 a 10.000 ID in un colpo (campo count) con opzione maiuscolo/minuscolo. ' +
      'Tutti generati con CSPRNG (`node:crypto`), mai `Math.random()` (predicibile). ' +
      'Output: { id, ids } (singolo) oppure { ids } (batch). ' +
      'Use case: chiave idempotency per chiamata API a valle; correlation-id per tracciare una richiesta ' +
      'attraverso più nodi/log; primary key v7 per i record creati dal workflow (insert veloci); token di ' +
      'condivisione pubblico URL-safe (nanoid); batch di N codici coupon univoci.',
    configFields: [
      {
        key: 'version', label: 'Formato ID', type: 'select', required: true, defaultValue: 'v4',
        options: ['v4', 'v7', 'ulid', 'short', 'nanoid'],
        help: 'v4 = random standard · v7 = ordinabile (ottimo per PK DB) · ulid/nanoid = compatti URL-safe · short = slug breve.',
      },
      {
        key: 'count', label: 'Quanti ID', type: 'number', required: false, defaultValue: '1',
        help: 'Da 1 a 10.000. >1 → output { ids: [...] }.',
      },
      {
        key: 'uppercase', label: 'Maiuscolo', type: 'boolean', required: false,
        help: 'ID in MAIUSCOLO invece di minuscolo.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: uuidExecutor,
};

// ════════════════════════════════════════════════════════════════════════
// action_jwt
// ════════════════════════════════════════════════════════════════════════
const JWT_ALGOS: Record<string, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
const jwtExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const c = await nodeCrypto();
  const op = str(config.operation, 'decode');
  const alg = str(config.algorithm, 'HS256');
  const hashAlgo = JWT_ALGOS[alg];
  if (!hashAlgo) throw new Error(`action_jwt: algoritmo non supportato "${alg}"`);

  if (op === 'decode') {
    const token = config.token !== undefined && str(config.token) !== '' ? str(config.token) : str(input);
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('action_jwt: token JWT malformato (servono 3 parti)');
    const headerR = tryParseJson(b64urlToBuf(parts[0]!).toString('utf8'));
    const payloadR = tryParseJson(b64urlToBuf(parts[1]!).toString('utf8'));
    if (!headerR.ok || !payloadR.ok) throw new Error('action_jwt: token non decodificabile (header o payload non sono JSON)');
    return { output: { header: headerR.value, payload: payloadR.value, verified: false }, durationMs: Date.now() - startedAt };
  }

  const secret = str(config.secret);
  if (!secret) throw new Error('action_jwt: secret obbligatorio per sign/verify');

  if (op === 'sign') {
    const payloadRaw = str(config.payload, '{}');
    const parsed = tryParseJson(payloadRaw);
    if (!parsed.ok) throw new Error('action_jwt: il payload da firmare non è un oggetto JSON valido');
    const payload = parsed.value;
    const now = Math.floor(Date.now() / 1000);
    payload.iat = now;
    const expiresIn = Number(config.expiresIn);
    if (Number.isFinite(expiresIn) && expiresIn > 0) payload.exp = now + expiresIn;
    const header = b64url(Buffer.from(JSON.stringify({ alg, typ: 'JWT' })));
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = b64url(c.createHmac(hashAlgo, secret).update(`${header}.${body}`).digest());
    return { output: { token: `${header}.${body}.${sig}`, payload }, durationMs: Date.now() - startedAt };
  }

  // verify
  const token = config.token !== undefined && str(config.token) !== '' ? str(config.token) : str(input);
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('action_jwt: token malformato');
  const expected = b64url(c.createHmac(hashAlgo, secret).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]!);
  const valid = a.length === b.length && c.timingSafeEqual(a, b);
  // Il payload di un token in arrivo è attacker-controlled: un base64 che NON
  // decodifica a JSON valido NON deve far crashare il verify (DoS / errore non
  // gestito) — il token è semplicemente non valido → verified:false.
  const payloadR = tryParseJson(b64urlToBuf(parts[1]!).toString('utf8'));
  if (!payloadR.ok) {
    return { output: { verified: false, signatureValid: valid, expired: false, payload: null, error: 'payload non-JSON (token malformato)' }, durationMs: Date.now() - startedAt };
  }
  const payload = payloadR.value;
  const notExpired = typeof payload.exp !== 'number' || payload.exp > Math.floor(Date.now() / 1000);
  return { output: { verified: valid && notExpired, signatureValid: valid, expired: !notExpired, payload }, durationMs: Date.now() - startedAt };
};

export const jwtNode: NodeModule = {
  def: {
    id: 'action_jwt',
    type: 'action',
    label: 'JWT',
    icon: 'key',
    color: '#8b5cf6',
    description:
      'Nodo JWT (JSON Web Token) completo — firma, verifica e decodifica — implementato su `node:crypto` HMAC ' +
      '(HS256/384/512) senza dipendenze esterne, con verifica della firma a TEMPO COSTANTE (timingSafeEqual) per ' +
      'neutralizzare i timing attack e controllo automatico della scadenza (claim `exp`). Tre operazioni da ' +
      'dropdown, campi condizionali in UI: ' +
      '(1) SIGN — crea un token firmato da un payload JSON: aggiunge automaticamente `iat` (issued-at) e, se ' +
      'specifichi una durata, `exp` (scadenza) — per emettere token di sessione, magic-link di accesso, inviti, ' +
      'API key temporanee a servizi a valle, handoff sicuro tra sistemi; ' +
      '(2) VERIFY — valida un token in arrivo: controlla la firma con il secret E la scadenza, restituendo ' +
      '`{ verified, signatureValid, expired, payload }` — il check da fare SEMPRE prima di fidarsi del contenuto ' +
      'di un token (es. webhook firmati JWT, callback OAuth, richieste autenticate da un altro tenant); ' +
      '(3) DECODE — legge header e payload SENZA verificare la firma (output `verified:false` esplicito per non ' +
      'illudere) — utile solo per ispezione/debug o per leggere claim non sensibili (es. quale `kid` usare). ' +
      'NB: il decode NON è una verifica — non fidarti mai del payload di un token non verificato. ' +
      'Output: token firmato, oppure { verified, payload, ... }. ' +
      'Use case: verifica un JWT in arrivo da un partner prima di accettare la richiesta (VERIFY); emetti un ' +
      'magic-link di accesso valido 15 minuti (SIGN con exp=900); ispeziona un token per estrarre il claim ' +
      '`sub`/`email` in debug (DECODE); genera un service-token per chiamare un\'API interna.',
    configFields: [
      {
        key: 'operation', label: 'Operazione', type: 'select', required: true, defaultValue: 'verify',
        options: ['sign', 'verify', 'decode'],
        help: 'sign = crea token · verify = valida firma+scadenza · decode = leggi senza verificare (debug).',
      },
      {
        key: 'algorithm', label: 'Algoritmo', type: 'select', required: false, defaultValue: 'HS256',
        options: ['HS256', 'HS384', 'HS512'],
        showIf: { field: 'operation', in: ['sign', 'verify'] },
      },
      {
        key: 'secret', label: 'Secret di firma', type: 'secret', required: false,
        help: 'Chiave segreta condivisa (HMAC). Obbligatoria per sign/verify.',
        showIf: { field: 'operation', in: ['sign', 'verify'] },
      },
      {
        key: 'payload', label: 'Payload (JSON)', type: 'json', required: false, defaultValue: '{\n  "sub": "user-123"\n}',
        help: 'Claim del token. iat (e exp se imposti la durata) sono aggiunti automaticamente.',
        showIf: { field: 'operation', equals: 'sign' },
      },
      {
        key: 'expiresIn', label: 'Scadenza (secondi)', type: 'number', required: false, defaultValue: '3600',
        help: 'Durata di validità in secondi (es. 900 = 15 min). Vuoto/0 = nessuna scadenza.',
        showIf: { field: 'operation', equals: 'sign' },
      },
      {
        key: 'token', label: 'Token', type: 'expression', required: false, defaultValue: 'input',
        help: 'Il JWT da verificare/decodificare. Vuoto = usa l\'input del nodo.',
        showIf: { field: 'operation', in: ['verify', 'decode'] },
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: jwtExecutor,
};
