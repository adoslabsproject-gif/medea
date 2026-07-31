/**
 * Estrazione del JSON dalla risposta del modello.
 *
 * Serve perché non tutti i provider garantiscono JSON puro: chi non supporta
 * `response_format` risponde spesso con il JSON dentro un blocco markdown, o
 * con una riga di prosa davanti. Il parser è tollerante di proposito — è la
 * differenza fra "funziona solo col modello giusto" e "funziona con tutti".
 */

/** Toglie i recinti markdown attorno al JSON, se ci sono. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*\n?/, '');
  const closeIdx = withoutOpen.lastIndexOf('```');
  return (closeIdx >= 0 ? withoutOpen.slice(0, closeIdx) : withoutOpen).trim();
}

/**
 * Primo oggetto JSON bilanciato nella stringa: conta le graffe ignorando
 * quelle dentro le stringhe, così una `{` nel testo di un campo non manda
 * fuori strada il conteggio.
 */
export function firstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export class ScaffoldParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldParseError';
  }
}

/** JSON dalla risposta grezza, o un errore che dice cosa è arrivato invece. */
export function parseScaffoldJson(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    const candidate = firstBalancedJsonObject(stripped);
    if (candidate !== null) {
      try {
        return JSON.parse(candidate);
      } catch (e) {
        throw new ScaffoldParseError(
          `Il modello ha prodotto un oggetto JSON malformato: ${String(e)}`,
        );
      }
    }
    const preview = stripped.slice(0, 200).replace(/\s+/g, ' ');
    throw new ScaffoldParseError(
      `La risposta non contiene un oggetto JSON. Inizia con: "${preview}…"`,
    );
  }
}
