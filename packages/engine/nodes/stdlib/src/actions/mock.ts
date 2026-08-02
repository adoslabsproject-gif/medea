/**
 * action_mock_data — generatore di dati di test realistici (con dataset italiano)
 * in JavaScript puro (ZERO dipendenze, browser-safe). Indispensabile per testare
 * un workflow senza dipendere da dati reali o da un servizio esterno. Seedabile
 * per output riproducibili.
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

const FIRST = [
  'Marco',
  'Giulia',
  'Luca',
  'Anna',
  'Francesco',
  'Sara',
  'Matteo',
  'Chiara',
  'Davide',
  'Elena',
  'Alessandro',
  'Martina',
];
const LAST = [
  'Rossi',
  'Russo',
  'Ferrari',
  'Esposito',
  'Bianchi',
  'Romano',
  'Colombo',
  'Ricci',
  'Marino',
  'Greco',
  'Bruno',
  'Gallo',
];
const CITIES = [
  'Roma',
  'Milano',
  'Napoli',
  'Torino',
  'Palermo',
  'Genova',
  'Bologna',
  'Firenze',
  'Bari',
  'Catania',
  'Verona',
  'Venezia',
];
const COMPANIES = [
  'Tecnologie',
  'Servizi',
  'Soluzioni',
  'Group',
  'Consulting',
  'Digital',
  'Industrie',
  'Sistemi',
];
const LOREM =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud'.split(
    ' ',
  );

/** PRNG deterministico (mulberry32) per output riproducibili con seed. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genValue(type: string, rng: () => number): unknown {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const first = pick(FIRST);
  const last = pick(LAST);
  switch (type) {
    case 'firstName':
      return first;
    case 'lastName':
      return last;
    case 'fullName':
      return `${first} ${last}`;
    case 'email':
      return `${first.toLowerCase()}.${last.toLowerCase()}@esempio.it`;
    case 'phone':
      return `+39 3${Math.floor(rng() * 9) + 1}${String(Math.floor(rng() * 9000000) + 1000000)}`;
    case 'company':
      return `${last} ${pick(COMPANIES)}`;
    case 'city':
      return pick(CITIES);
    case 'word':
      return pick(LOREM);
    case 'sentence':
      return `${pick(LOREM)} ${pick(LOREM)} ${pick(LOREM)} ${pick(LOREM)} ${pick(LOREM)}`;
    case 'paragraph':
      return Array.from({ length: 4 }, () =>
        Array.from({ length: 8 }, () => pick(LOREM)).join(' '),
      ).join('. ');
    case 'integer':
      return Math.floor(rng() * 1000);
    case 'number':
      return Math.round(rng() * 100000) / 100;
    case 'boolean':
      return rng() > 0.5;
    case 'uuid': {
      const hex = '0123456789abcdef';
      let s = '';
      // UUID v4 conforme: pos 14 = version '4', pos 19 = variant (8/9/a/b), il resto random.
      for (let i = 0; i < 36; i += 1) {
        s +=
          i === 8 || i === 13 || i === 18 || i === 23
            ? '-'
            : i === 14
              ? '4'
              : i === 19
                ? hex[8 + Math.floor(rng() * 4)]
                : hex[Math.floor(rng() * 16)];
      }
      return s;
    }
    case 'date':
      return new Date(Date.now() + (rng() - 0.5) * 2 * 365 * 86400000).toISOString();
    case 'pastDate':
      return new Date(Date.now() - rng() * 365 * 86400000).toISOString();
    case 'futureDate':
      return new Date(Date.now() + rng() * 365 * 86400000).toISOString();
    default:
      return null;
  }
}

const mockExecutor: NodeExecutor = async (config) => {
  const startedAt = Date.now();
  const count = Math.min(Math.max(Number(config.count) || 1, 1), 1000);
  const seedRaw = str(config.seed);
  const baseSeed =
    seedRaw !== ''
      ? [...seedRaw].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
      : Math.floor(Math.random() * 2 ** 31);
  const rng = makeRng(baseSeed);

  let schema: Record<string, string> = {};
  const rawSchema = config.schema;
  if (rawSchema && typeof rawSchema === 'object') schema = rawSchema as Record<string, string>;
  else if (typeof rawSchema === 'string' && rawSchema.trim() !== '') {
    try {
      schema = JSON.parse(rawSchema) as Record<string, string>;
    } catch {
      schema = {};
    }
  }
  if (Object.keys(schema).length === 0)
    schema = { id: 'uuid', nome: 'fullName', email: 'email', citta: 'city' };

  const items = Array.from({ length: count }, () => {
    const obj: Record<string, unknown> = {};
    for (const [field, type] of Object.entries(schema)) obj[field] = genValue(str(type), rng);
    return obj;
  });

  return {
    output: { items, count: items.length, seed: seedRaw || null },
    durationMs: Date.now() - startedAt,
  };
};

export const mockDataNode: NodeModule = {
  def: {
    id: 'action_mock_data',
    type: 'action',
    label: 'Dati di test',
    icon: 'database',
    color: '#0d9488',
    description:
      'Genera dati di test realistici con dataset ITALIANO (nomi, cognomi, città, aziende verosimili) in ' +
      'JavaScript puro (zero dipendenze) — per sviluppare e collaudare un workflow senza dipendere da dati di ' +
      'produzione o da un servizio esterno ancora non pronto. Definisci uno schema (editor chiave/valore: ' +
      '"nomeCampo" → "tipo") e il nodo produce N record coerenti. Tipi disponibili: firstName, lastName, ' +
      'fullName, email, phone (formato +39 italiano), company, city (città italiane), word, sentence, paragraph ' +
      '(testo lorem), integer, number, boolean, uuid (v4), date, pastDate, futureDate (in ISO 8601). ' +
      "Fondamentale: con un SEED (qualsiasi stringa) l'output è RIPRODUCIBILE — gli stessi dati a ogni esecuzione, " +
      'così i test sono deterministici e ripetibili; senza seed i dati sono casuali a ogni run. Da 1 a 1.000 ' +
      'record per chiamata. Se non definisci uno schema, ne usa uno di default (id, nome, email, città). ' +
      'Output: { items, count, seed }. ' +
      'Use case: popola un workflow in sviluppo con 50 finti lead per testare il ramo di elaborazione; genera ' +
      'dati riproducibili (seed) per un test automatico che deve dare sempre lo stesso risultato; crea un dataset ' +
      "di esempio da inviare a un'API in staging; produci righe finte per provare un nodo CSV/email senza usare " +
      'clienti reali.',
    configFields: [
      {
        key: 'schema',
        label: 'Schema (campo → tipo)',
        type: 'key-value',
        required: false,
        help: 'Ogni riga: nome del campo → tipo (fullName, email, phone, city, uuid, integer, pastDate, …). Vuoto = schema di default.',
      },
      {
        key: 'count',
        label: 'Quanti record',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Da 1 a 1.000.',
      },
      {
        key: 'seed',
        label: 'Seed (riproducibilità)',
        type: 'text',
        required: false,
        placeholder: 'es. test-ordini',
        help: 'Una stringa qualsiasi: stesso seed = stessi dati a ogni esecuzione. Vuoto = casuale.',
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: mockExecutor,
};
