/**
 * action_datetime — manipolazione date/orari enterprise in JavaScript puro: usa
 * solo `Date` e `Intl` (built-in, ZERO dipendenze, ZERO `node:*`, browser-safe).
 * Sostituisce il nodo Date & Time di n8n e l'uso del nodo Code per le date, con
 * supporto a fuso orario e locale (formattazione italiana nativa).
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
function parseDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const s = str(v).trim();
  if (s === '' || s.toLowerCase() === 'now') return new Date();
  // epoch secondi o millisecondi
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`action_datetime: data non valida "${s}"`);
  return d;
}
const MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};
/**
 * Aggiunge `months` mesi CLAMPando il giorno all'ultimo giorno del mese target —
 * evita l'overflow di `setMonth` (31 gen + 1 mese darebbe "31 feb" → 3 mar; 29 feb
 * + 12 mesi darebbe "29 feb" non bisestile → 1 mar). Atteso: 28/29 feb. Ora e
 * componenti orari sono preservati. Gli anni si esprimono come 12×mesi.
 */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetDay = d.getDate();
  d.setDate(1); // neutralizza l'overflow prima di cambiare mese
  d.setMonth(d.getMonth() + Math.trunc(months));
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(targetDay, lastDayOfTargetMonth));
  return d;
}
function shift(date: Date, amount: number, unit: string): Date {
  const d = new Date(date.getTime());
  if (unit === 'months') return addMonths(d, amount);
  if (unit === 'years') return addMonths(d, amount * 12);
  const ms = MS[unit];
  if (ms === undefined) throw new Error(`action_datetime: unità sconosciuta "${unit}"`);
  return new Date(d.getTime() + amount * ms);
}

const datetimeExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'format');
  const rawDate = config.date !== undefined && str(config.date) !== '' ? config.date : input;

  if (op === 'now') {
    const d = new Date();
    return {
      output: {
        iso: d.toISOString(),
        epochMs: d.getTime(),
        epochSec: Math.floor(d.getTime() / 1000),
      },
      durationMs: Date.now() - startedAt,
    };
  }

  if (op === 'diff') {
    const a = parseDate(rawDate);
    const b = parseDate(config.dateB);
    const unit = str(config.unit, 'days');
    const deltaMs = b.getTime() - a.getTime();
    let value: number;
    if (unit === 'months')
      value = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    else if (unit === 'years') value = b.getFullYear() - a.getFullYear();
    else value = deltaMs / (MS[unit] ?? 1);
    return {
      output: { value, rounded: Math.trunc(value), unit, absMs: Math.abs(deltaMs) },
      durationMs: Date.now() - startedAt,
    };
  }

  const date = parseDate(rawDate);

  if (op === 'add' || op === 'subtract') {
    const amount = (Number(config.amount) || 0) * (op === 'subtract' ? -1 : 1);
    const result = shift(date, amount, str(config.unit, 'days'));
    return {
      output: { iso: result.toISOString(), epochMs: result.getTime() },
      durationMs: Date.now() - startedAt,
    };
  }

  if (op === 'format') {
    const timeZone = str(config.timezone, 'Europe/Rome') || 'Europe/Rome';
    const locale = str(config.locale, 'it-IT') || 'it-IT';
    const preset = str(config.preset, 'datetime');
    let formatted: string;
    if (preset === 'iso') {
      formatted = date.toISOString();
    } else if (preset === 'date') {
      formatted = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(date);
    } else if (preset === 'time') {
      formatted = new Intl.DateTimeFormat(locale, { timeStyle: 'medium', timeZone }).format(date);
    } else if (preset === 'full') {
      formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone,
      }).format(date);
    } else if (preset === 'relative') {
      const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      const abs = Math.abs(diffSec);
      const [unit, div]: [Intl.RelativeTimeFormatUnit, number] =
        abs < 60
          ? ['second', 1]
          : abs < 3600
            ? ['minute', 60]
            : abs < 86400
              ? ['hour', 3600]
              : abs < 2592000
                ? ['day', 86400]
                : abs < 31536000
                  ? ['month', 2592000]
                  : ['year', 31536000];
      formatted = rtf.format(Math.round(diffSec / div), unit);
    } else {
      formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone,
      }).format(date);
    }
    return {
      output: {
        formatted,
        iso: date.toISOString(),
        epochMs: date.getTime(),
        weekday: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone }).format(date),
      },
      durationMs: Date.now() - startedAt,
    };
  }

  throw new Error(`action_datetime: operazione sconosciuta "${op}"`);
};

export const datetimeNode: NodeModule = {
  def: {
    id: 'action_datetime',
    type: 'action',
    label: 'Data/Ora',
    icon: 'clock',
    color: '#0d9488',
    description:
      'Nodo data/ora completo in JavaScript puro (solo Date + Intl, zero dipendenze) con supporto NATIVO a fuso ' +
      "orario e locale italiano — risolve il dolore numero uno dell'automazione: lavorare con le date senza " +
      'sbagliare timezone o formato. Cinque operazioni da dropdown: ' +
      '(1) NOW — istante corrente in tutti i formati utili (ISO 8601, epoch in millisecondi e secondi) per ' +
      'timestamp, idempotency, log; ' +
      '(2) FORMAT — formatta una data nel modo giusto per gli umani con preset (data breve, data estesa, solo ' +
      'ora, completo, ISO) E in formato RELATIVO ("3 ore fa", "tra 2 giorni") tramite Intl.RelativeTimeFormat, ' +
      'tutto rispettando fuso orario (default Europe/Rome) e lingua (default it-IT) — niente più date in inglese o ' +
      'in UTC nelle email ai clienti; restituisce anche il giorno della settimana; ' +
      '(3) ADD / (4) SUBTRACT — aggiunge o sottrae un intervallo (secondi, minuti, ore, giorni, settimane, mesi, ' +
      'anni) gestendo correttamente i mesi di lunghezza diversa e gli anni bisestili (scadenze fattura a +30 ' +
      'giorni, promemoria, date di rinnovo, finestre temporali); ' +
      "(5) DIFF — calcola la differenza tra due date nell'unità scelta (giorni di ritardo di un pagamento, età di " +
      'un lead, durata tra due eventi), con valore esatto e troncato. ' +
      'Accetta in ingresso ISO, epoch (secondi o ms, riconosciuti automaticamente), stringhe di data comuni o ' +
      '"now". Output a seconda dell\'operazione: { iso, epochMs, epochSec } / { formatted, weekday, ... } / ' +
      '{ value, rounded, unit }. ' +
      'Use case: scadenza fattura = oggi + 30 giorni (ADD); "ordine ricevuto 2 ore fa" in un alert (FORMAT ' +
      "relative); giorni di ritardo di un pagamento (DIFF); data di consegna formattata in italiano nell'email " +
      '(FORMAT full it-IT); timestamp ISO per un record (NOW).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        defaultValue: 'format',
        options: ['now', 'format', 'add', 'subtract', 'diff'],
        help: 'now = adesso · format = formatta · add/subtract = sposta · diff = differenza tra due date.',
      },
      {
        key: 'date',
        label: 'Data',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        placeholder: 'ISO, epoch, "now" o input',
        help: 'La data di partenza (ISO, epoch sec/ms, o "now"). Vuoto = usa l\'input del nodo.',
        showIf: { field: 'operation', in: ['format', 'add', 'subtract', 'diff'] },
      },
      {
        key: 'dateB',
        label: 'Seconda data',
        type: 'expression',
        required: false,
        defaultValue: 'now',
        help: 'La data di confronto per DIFF (differenza = secondaData − data).',
        showIf: { field: 'operation', equals: 'diff' },
      },
      {
        key: 'preset',
        label: 'Formato',
        type: 'select',
        required: false,
        defaultValue: 'datetime',
        options: ['datetime', 'date', 'time', 'full', 'iso', 'relative'],
        help: 'Come formattare. "relative" = "3 ore fa" · "iso" = 8601 · gli altri rispettano locale+timezone.',
        showIf: { field: 'operation', equals: 'format' },
      },
      {
        key: 'timezone',
        label: 'Fuso orario',
        type: 'timezone-picker',
        required: false,
        defaultValue: 'Europe/Rome',
        help: 'Fuso IANA per la formattazione (es. Europe/Rome).',
        showIf: { field: 'operation', equals: 'format' },
      },
      {
        key: 'locale',
        label: 'Lingua',
        type: 'select',
        required: false,
        defaultValue: 'it-IT',
        options: ['it-IT', 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES'],
        help: 'Lingua per nomi di mese/giorno e formato relativo.',
        showIf: { field: 'operation', equals: 'format' },
      },
      {
        key: 'amount',
        label: 'Quantità',
        type: 'number',
        required: false,
        defaultValue: '1',
        help: 'Quante unità aggiungere/sottrarre.',
        showIf: { field: 'operation', in: ['add', 'subtract'] },
      },
      {
        key: 'unit',
        label: 'Unità',
        type: 'select',
        required: false,
        defaultValue: 'days',
        options: ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'],
        help: 'Unità di tempo per add/subtract/diff.',
        showIf: { field: 'operation', in: ['add', 'subtract', 'diff'] },
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: datetimeExecutor,
};
