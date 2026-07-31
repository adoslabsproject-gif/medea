/**
 * humanizeCron — descrizione in italiano di un'espressione cron a 5 campi.
 *
 * Sostituisce `cronstrue` (bundle UMD che crashava in produzione per un difetto
 * di interop minificato — incident 2026-06-09). Codice nostro, zero dipendenze:
 * non può rompersi col bundling, ed è interamente coperto dai test. Possediamo
 * il confine invece di dipendere da una libreria fragile.
 *
 * Campi cron: minuto(0-59) ora(0-23) giorno-del-mese(1-31) mese(1-12)
 * giorno-della-settimana(0-6, con 0 e 7 = domenica).
 */

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = [
  '',
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Unisce una lista in italiano: [a,b,c] → "a, b e c". */
function joinIt(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]!}`;
}

type FieldSpec =
  | { kind: 'any' }
  | { kind: 'step'; step: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'list'; values: number[] }
  | { kind: 'single'; value: number };

/** Parsa un campo cron in una forma strutturata. Lancia se non riconosciuto. */
function parseField(raw: string): FieldSpec {
  if (raw === '*') return { kind: 'any' };
  const step = /^\*\/(\d+)$/.exec(raw);
  if (step) {
    const s = Number(step[1]);
    if (!Number.isFinite(s) || s <= 0) throw new Error('step');
    return { kind: 'step', step: s };
  }
  const range = /^(\d+)-(\d+)$/.exec(raw);
  if (range) {
    return { kind: 'range', from: Number(range[1]), to: Number(range[2]) };
  }
  if (raw.includes(',')) {
    const values = raw.split(',').map((p) => {
      if (!/^\d+$/.test(p)) throw new Error('list');
      return Number(p);
    });
    return { kind: 'list', values };
  }
  if (/^\d+$/.test(raw)) return { kind: 'single', value: Number(raw) };
  throw new Error(`campo non riconosciuto: ${raw}`);
}

/** Descrizione della parte oraria (minuto + ora). */
function describeTime(min: FieldSpec, hour: FieldSpec): string {
  // Ogni minuto / ogni N minuti
  if (min.kind === 'any' && hour.kind === 'any') return 'ogni minuto';
  if (min.kind === 'step' && hour.kind === 'any') {
    return min.step === 1 ? 'ogni minuto' : `ogni ${min.step} minuti`;
  }
  // Minuto fisso, ogni ora
  if (min.kind === 'single' && hour.kind === 'any') {
    return min.value === 0 ? 'ogni ora' : `ogni ora al minuto ${min.value}`;
  }
  // Ogni N ore a un minuto fisso
  if (min.kind === 'single' && hour.kind === 'step') {
    return `al minuto ${min.value} ogni ${hour.step} ore`;
  }
  // Orario/i preciso/i
  if (min.kind === 'single' && hour.kind === 'single') {
    return `alle ${pad2(hour.value)}:${pad2(min.value)}`;
  }
  if (min.kind === 'single' && hour.kind === 'list') {
    const times = hour.values.map((h) => `${pad2(h)}:${pad2(min.value)}`);
    return `alle ${joinIt(times)}`;
  }
  if (min.kind === 'single' && hour.kind === 'range') {
    return `ogni ora dalle ${pad2(hour.from)}:${pad2(min.value)} alle ${pad2(hour.to)}:${pad2(min.value)}`;
  }
  if (min.kind === 'any' && hour.kind === 'single') {
    return `ogni minuto dalle ${pad2(hour.value)}:00 alle ${pad2(hour.value)}:59`;
  }
  throw new Error('time non descrivibile');
}

/** Descrizione di un campo giorno-della-settimana. */
function describeWeekday(dow: FieldSpec): string {
  const name = (v: number): string => WEEKDAYS[v === 7 ? 0 : v] ?? `giorno ${v}`;
  switch (dow.kind) {
    case 'single':
      return `ogni ${name(dow.value)}`;
    case 'range':
      return `da ${name(dow.from)} a ${name(dow.to)}`;
    case 'list':
      return joinIt(dow.values.map(name));
    case 'step':
      return dow.step === 1 ? 'ogni giorno' : `ogni ${dow.step} giorni della settimana`;
    default:
      return 'ogni giorno';
  }
}

/** Descrizione della parte calendario (giorno del mese, mese, giorno settimana). */
function describeDay(dom: FieldSpec, mon: FieldSpec, dow: FieldSpec): string {
  const monthSuffix =
    mon.kind === 'single'
      ? ` di ${MONTHS[mon.value] ?? `mese ${mon.value}`}`
      : mon.kind === 'list'
        ? ` di ${joinIt(mon.values.map((m) => MONTHS[m] ?? `mese ${m}`))}`
        : '';

  // Giorno della settimana specificato (dom = any): "da lunedì a venerdì"
  if (dow.kind !== 'any' && dom.kind === 'any') {
    return `${describeWeekday(dow)}${monthSuffix}`;
  }
  // Giorno del mese specificato
  if (dom.kind !== 'any') {
    const domPart =
      dom.kind === 'single'
        ? `il giorno ${dom.value}`
        : dom.kind === 'list'
          ? `i giorni ${joinIt(dom.values.map(String))}`
          : dom.kind === 'range'
            ? `dal giorno ${dom.from} al ${dom.to}`
            : dom.kind === 'step'
              ? `ogni ${dom.step} giorni`
              : 'ogni giorno';
    const base = monthSuffix ? `${domPart}${monthSuffix}` : `${domPart} del mese`;
    // Caso raro: anche dow specificato (semantica OR di cron)
    if (dow.kind !== 'any') return `${base} e ${describeWeekday(dow)}`;
    return base;
  }
  // Nessun vincolo di giorno → ogni giorno (eventualmente in certi mesi)
  return monthSuffix ? `ogni giorno${monthSuffix}` : 'ogni giorno';
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Converte un'espressione cron a 5 campi in italiano leggibile.
 * Input vuoto → "—". Non-5-campi o sintassi ignota → messaggio chiaro (mai throw).
 */
export function humanizeCron(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return '—';
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return 'Espressione non valida (servono 5 campi)';
  try {
    const [min, hour, dom, mon, dow] = parts.map(parseField) as [
      FieldSpec,
      FieldSpec,
      FieldSpec,
      FieldSpec,
      FieldSpec,
    ];
    const time = describeTime(min, hour);
    const day = describeDay(dom, mon, dow);

    // Frequenza sub-giornaliera ("ogni minuto/ora…"): il giorno è un qualificatore.
    const subDaily =
      time.startsWith('ogni minuto') ||
      (time.startsWith('ogni ') && time.includes('minut')) ||
      time.startsWith('ogni ora') ||
      time.startsWith('al minuto');
    if (subDaily) {
      return day === 'ogni giorno' ? capitalize(time) : `${capitalize(time)}, ${day}`;
    }
    // Orario preciso: "<Giorno> <alle HH:MM>"
    return `${capitalize(day)} ${time}`;
  } catch {
    return `Espressione cron: ${trimmed}`;
  }
}
