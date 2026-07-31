/**
 * I segnaposto che i modelli mettono quando non sanno cosa scrivere.
 *
 * `smtp.example.com`, `your-api-key`, `my-bucket`: sembrano configurazioni
 * vere e passano qualunque controllo di forma, ma a runtime falliscono
 * sempre. Riconoscerli qui è ciò che separa un workflow che si può premere
 * «Importa» da uno che si rompe al primo giro.
 *
 * Le espressioni del motore — `{{secrets.X}}`, `{{$node.Y.json}}` — non sono
 * segnaposto e non compaiono in questa lista.
 */

export interface MockPattern {
  regex: RegExp;
  reason: string;
  suggest?: string;
}

export const MOCK_PATTERNS: readonly MockPattern[] = [
  // Domini e host inventati.
  {
    regex: /\bsmtp\.example\.com\b/i,
    reason: 'host SMTP fittizio "smtp.example.com"',
    suggest: 'il tuo host reale (es. smtp.gmail.com)',
  },
  {
    regex: /\bexample\.(com|org|net|io|biz)\b/i,
    reason: 'dominio fittizio "example.*"',
    suggest: 'il tuo dominio reale',
  },
  {
    regex:
      /\b(your|my|company|yourcompany|mycompany|acme|foo|bar|test|demo|sample|miosito|mio-sito|tuosito|tuo-sito|tuodominio|miodominio|nostrosito|nostrodominio|placeholder|esempio)\.(com|org|net|io|biz|local|it|eu)\b/i,
    reason: 'dominio segnaposto (anche nelle varianti italiane miosito/tuodominio)',
    suggest: 'il dominio reale oppure {{secrets.DOMAIN}}',
  },
  {
    regex: /\bcompany\.com\b/i,
    reason: 'dominio fittizio "company.com"',
    suggest: 'il tuo dominio aziendale reale',
  },
  {
    regex: /\b(yourdomain|domain|hostname|server)\.(com|local|tld)\b/i,
    reason: 'host segnaposto generico',
    suggest: "l'host reale",
  },
  {
    regex: /\b(localhost|0\.0\.0\.0|127\.0\.0\.1)\b/i,
    reason: 'host di loopback (probabilmente non intenzionale)',
    suggest: "l'indirizzo pubblico reale",
  },

  // Indirizzi email.
  {
    regex: /\bnoreply@(?!example\.|test\.|sample\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,
    reason: 'email noreply con dominio segnaposto',
    suggest: '{{secrets.NOREPLY_EMAIL}} o un indirizzo aziendale reale',
  },
  {
    regex:
      /\b(management|admin|test|user|info|support|hello|contact|sales|marketing|root)@(?!.*\.)/i,
    reason: 'indirizzo email incompleto',
    suggest: "l'indirizzo completo o {{secrets.EMAIL}}",
  },
  {
    regex:
      /\b[A-Za-z0-9._%+-]+@(company|yourcompany|mycompany|acme|foo|bar|test|demo|sample|placeholder)\.[A-Za-z]{2,}\b/i,
    reason: 'email con dominio aziendale segnaposto',
    suggest: '{{secrets.EMAIL}} o un indirizzo reale',
  },

  // Bucket e storage.
  {
    regex:
      /\bs3:\/\/(my-bucket|your-bucket|bucket-name|bucket|test-bucket|sample-bucket|demo-bucket|example-bucket|company-bucket|tenant-bucket|placeholder-bucket)(?:[/-]|$)/i,
    reason: 'bucket S3 segnaposto',
    suggest: 'il nome reale del bucket o {{secrets.S3_BUCKET}}',
  },
  {
    regex: /\bgs:\/\/(my-bucket|your-bucket|bucket-name|bucket)\b/i,
    reason: 'bucket GCS segnaposto',
    suggest: 'il bucket reale o {{secrets.GCS_BUCKET}}',
  },
  {
    regex: /\b(my-bucket|your-bucket|bucket-name|tenant-bucket|placeholder-bucket)\b/i,
    reason: 'nome bucket segnaposto',
    suggest: 'il nome reale o {{secrets.BUCKET_NAME}}',
  },

  // Credenziali.
  {
    regex: /\byour[_-]?api[_-]?key\b/i,
    reason: 'chiave API segnaposto "your-api-key"',
    suggest: '{{secrets.API_KEY}}',
  },
  {
    regex:
      /\b(your|my|test|sample|demo)[_-]?(token|secret|password|api_?key|access_?key|client_?id|client_?secret)\b/i,
    reason: 'credenziale segnaposto',
    suggest: '{{secrets.NOME}} con il segreto vero',
  },
  {
    regex: /\bsk_(test|live)_(your|placeholder|sample)/i,
    reason: 'chiave Stripe segnaposto',
    suggest: '{{secrets.STRIPE_KEY}}',
  },
  {
    regex: /\bAKIA[A-Z0-9]{16}\b/,
    reason: 'AWS Access Key ID scritta in chiaro (rischio di sicurezza)',
    suggest: '{{secrets.AWS_ACCESS_KEY_ID}}',
  },

  // Identificativi di risorse.
  {
    regex:
      /\b(email|smtp|imap|account|user|db|database|workspace|project|tenant)[_-]?(account[_-]?)?[_-]?[0-9]+\b/i,
    reason: 'identificativo segnaposto (es. account-1, db-1, user-123)',
    suggest: "selezionalo dal menu a tendina o usa l'identificativo vero",
  },
  {
    regex:
      /\b(account|workspace|project|tenant|database|table)[_-]?(name|id)[_-]?(here|placeholder|example|sample)\b/i,
    reason: 'identificativo di risorsa generico',
    suggest: "l'identificativo reale",
  },
  {
    regex: /\bdb[_-]?(opportunities|customers|orders|invoices|leads)\b/i,
    reason: 'identificativo di database inventato ("db_opportunities" non è un id vero)',
    suggest: 'selezionalo dal menu a tendina o usa l’UUID reale',
  },

  // Endpoint.
  {
    regex:
      /\bhttps?:\/\/(api|service|endpoint|server|host)\.(example|company|yourcompany|placeholder)\.(com|org|net)\b/i,
    reason: 'endpoint segnaposto',
    suggest: "l'URL reale del servizio o {{secrets.API_URL}}",
  },
  {
    regex: /\bhttps?:\/\/(api|service|server)\.example\.com/i,
    reason: 'URL di API fittizio',
    suggest: "l'URL reale del tuo servizio",
  },

  // Segnaposto letterali.
  { regex: /\bxxx+\b/i, reason: 'segnaposto generico "xxx…"', suggest: 'il valore reale' },
  { regex: /\bTODO\b/, reason: '"TODO" non risolto', suggest: 'completa il valore' },
  { regex: /\bFIXME\b/, reason: '"FIXME" non risolto', suggest: 'risolvi il valore' },
  {
    regex: /\bplaceholder\b/i,
    reason: 'la parola "placeholder" lasciata nel valore',
    suggest: 'sostituiscila con il valore reale',
  },
  { regex: /\bchange[_-]?me\b/i, reason: '"change_me" non sostituito', suggest: 'il valore reale' },
  {
    regex:
      /\b(your|my|sample|test|example|demo)[_-]?(value|name|id|key|token|url|host|port|password|secret)\b/i,
    reason: 'segnaposto generico tipo "your_value"',
    suggest: 'il valore reale o {{secrets.NOME}}',
  },
  {
    regex: /<[A-Z_]{3,}>/,
    reason: 'segnaposto fra parentesi angolari <NOME_VAR>',
    suggest: 'il valore reale o un’espressione {{…}}',
  },
  {
    regex: /\$\{[A-Z_]{3,}\}/,
    reason: 'segnaposto in stile shell ${NOME_VAR}',
    suggest: 'usa {{secrets.NOME}} o {{$node.X.json}}',
  },
];

/** I campi il cui segnaposto rompe il workflow al primo giro. Su questi la
 *  severità sale a critica. */
export const CRITICAL_FIELD_RE =
  /smtp|url|host|bucket|endpoint|directory|account|database|table|api_?key|token|secret|password|credential|workspace|tenant/i;

/** Valori talmente compromettenti da essere critici ovunque compaiano. */
export const CRITICAL_VALUE_RE = /smtp\.example|my-bucket|your-api-key/i;
