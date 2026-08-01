/**
 * Versioned Node API — classificazione di compatibilità tra la versione del
 * NodeDef PINNATA su un'istanza CanvasNode (al momento della creazione) e la
 * versione CORRENTE dello stesso def nel runtime.
 *
 * Modello (n8n `typeVersion`): quando l'utente droppa un nodo, l'editor pinna
 * `CanvasNode.defVersion = def.version`. Se in seguito il def evolve, il
 * workflow salvato ricorda con quale versione fu configurato → l'engine può
 * rilevare un DRIFT e renderlo visibile (osservabilità), senza rompere i
 * workflow legacy (backward-compat: un drift non blocca mai l'esecuzione).
 *
 * Semver: `MAJOR.MINOR.PATCH`. Per convenzione SemVer un bump MAJOR segnala un
 * cambiamento potenzialmente BREAKING dei config/contratto del nodo; MINOR è
 * additivo (retro-compatibile), PATCH è fix interno. La severità del drift
 * mappa direttamente su questa semantica.
 */

/** Esito del confronto versione pinnata ↔ corrente. */
export type NodeVersionCompat =
  | 'unversioned' // una delle due versioni manca → nodo legacy, nessun enforcement
  | 'current' // pinnata === corrente → nessun drift
  | 'patch-behind' // corrente avanti di sola PATCH → safe
  | 'minor-behind' // corrente avanti di MINOR → safe (additivo)
  | 'major-behind' // corrente avanti di MAJOR → potenziale BREAKING
  | 'ahead'; // pinnata > corrente → workflow creato con runtime più nuovo (downgrade)

/** Delta osservabile registrato sullo step di un run (sottoinsieme "rilevante"). */
export type NodeVersionDrift = 'major' | 'minor' | 'patch' | 'ahead';

interface Semver { major: number; minor: number; patch: number }

function parseSemver(v: string | undefined): Semver | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  // m[1..3] garantiti dal match: parse sicuro.
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 se a<b, 0 se uguali, 1 se a>b. */
function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Classifica la compatibilità tra la versione pinnata sull'istanza e quella
 * corrente del def. Robusta a versioni mancanti o malformate → 'unversioned'
 * (mai un falso "drift" su dati legacy o non-semver).
 */
export function classifyNodeVersionCompat(
  pinned: string | undefined,
  current: string | undefined,
): NodeVersionCompat {
  const p = parseSemver(pinned);
  const c = parseSemver(current);
  if (!p || !c) return 'unversioned';
  const cmp = compareSemver(p, c);
  if (cmp === 0) return 'current';
  if (cmp > 0) return 'ahead'; // pinnata più nuova del runtime
  // pinnata indietro rispetto alla corrente → classifica per "ampiezza" del salto
  if (p.major !== c.major) return 'major-behind';
  if (p.minor !== c.minor) return 'minor-behind';
  return 'patch-behind';
}

/**
 * Mappa la compatibilità su un delta osservabile da registrare nello step del
 * run, oppure `null` se non c'è nulla di rilevante da segnalare (current /
 * unversioned). Solo i drift "veri" (corrente avanti, o pinnata avanti)
 * producono telemetria.
 */
export function nodeVersionDrift(compat: NodeVersionCompat): NodeVersionDrift | null {
  switch (compat) {
    case 'major-behind': return 'major';
    case 'minor-behind': return 'minor';
    case 'patch-behind': return 'patch';
    case 'ahead': return 'ahead';
    case 'current':
    case 'unversioned':
      return null;
  }
}

/**
 * True solo per i drift potenzialmente BREAKING — quelli su cui la UI deve
 * attirare l'attenzione dell'utente (badge "da migrare") e l'engine deve
 * loggare a livello warning. MAJOR-behind (config potenzialmente incompatibili)
 * e AHEAD (il runtime è più vecchio del workflow → un campo nuovo può mancare).
 */
export function isBreakingNodeVersionDrift(compat: NodeVersionCompat): boolean {
  return compat === 'major-behind' || compat === 'ahead';
}
