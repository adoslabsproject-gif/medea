/**
 * Le scelte dell'utente per Claude Code dentro Medea: modello, cartella di
 * lavoro, e la sessione della CLI di ogni conversazione.
 */

const MODELLO_KEY = 'medea.ai.claudeCode.modello';
const CARTELLA_KEY = 'medea.ai.claudeCode.cartella';
const SESSIONI_KEY = 'medea.ai.claudeCode.sessioni';
const COMANDI_KEY = 'medea.ai.claudeCode.comandi';

/** Quante sessioni si ricordano: oltre, si dimenticano le più vecchie. */
const MASSIMO_SESSIONI = 200;

/**
 * I modelli fra cui scegliere, con i nomi brevi che la CLI accetta.
 * `default` lascia decidere alla CLI, cioè alle impostazioni dell'utente.
 */
export const MODELLI = [
  { id: 'default', label: 'Predefinito di Claude Code' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] as const;

export type ModelloId = (typeof MODELLI)[number]['id'];

function isModello(value: unknown): value is ModelloId {
  return MODELLI.some((m) => m.id === value);
}

export function modelloScelto(): ModelloId {
  const salvato = localStorage.getItem(MODELLO_KEY);
  return isModello(salvato) ? salvato : 'default';
}

export function scegliModello(modello: ModelloId): void {
  if (modello === 'default') localStorage.removeItem(MODELLO_KEY);
  else localStorage.setItem(MODELLO_KEY, modello);
}

/** La cartella in cui Claude Code lavora, o `null` per quella vuota di Medea. */
export function cartellaScelta(): string | null {
  const salvata = localStorage.getItem(CARTELLA_KEY)?.trim() ?? '';
  return salvata === '' ? null : salvata;
}

export function scegliCartella(cartella: string | null): void {
  const pulita = cartella?.trim();
  if (pulita) localStorage.setItem(CARTELLA_KEY, pulita);
  else localStorage.removeItem(CARTELLA_KEY);
}

function leggiSessioni(): [string, string][] {
  try {
    const grezzo: unknown = JSON.parse(localStorage.getItem(SESSIONI_KEY) ?? '[]');
    if (!Array.isArray(grezzo)) return [];
    return grezzo.filter(
      (v): v is [string, string] =>
        Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * La chiave di una sessione: conversazione **e** cartella.
 *
 * La CLI tiene le sessioni cartella per cartella: riprenderne una da un'altra
 * cartella fallisce, e cambiare cartella a metà conversazione vuol dire
 * cominciare un lavoro diverso.
 */
function chiave(conversazione: string): string {
  return `${conversazione}\u0000${cartellaScelta() ?? ''}`;
}

/** La sessione della CLI con cui proseguire quella conversazione, se c'è. */
export function sessioneDi(conversazione: string | null): string | null {
  if (!conversazione) return null;
  const k = chiave(conversazione);
  return leggiSessioni().find(([c]) => c === k)?.[1] ?? null;
}

export function ricordaSessione(conversazione: string | null, sessione: string): void {
  if (!conversazione || !sessione) return;
  const k = chiave(conversazione);
  const altre = leggiSessioni().filter(([c]) => c !== k);
  const tutte = [...altre, [k, sessione] as [string, string]].slice(-MASSIMO_SESSIONI);
  localStorage.setItem(SESSIONI_KEY, JSON.stringify(tutte));
}

export function dimenticaSessione(conversazione: string | null): void {
  if (!conversazione) return;
  const k = chiave(conversazione);
  localStorage.setItem(SESSIONI_KEY, JSON.stringify(leggiSessioni().filter(([c]) => c !== k)));
}

/** I comandi `/` che la CLI ha dichiarato l'ultima volta che è partita. */
export function comandiNoti(): string[] {
  try {
    const grezzo: unknown = JSON.parse(localStorage.getItem(COMANDI_KEY) ?? '[]');
    return Array.isArray(grezzo) ? grezzo.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function ricordaComandi(comandi: readonly string[]): void {
  if (comandi.length > 0) localStorage.setItem(COMANDI_KEY, JSON.stringify(comandi));
}
