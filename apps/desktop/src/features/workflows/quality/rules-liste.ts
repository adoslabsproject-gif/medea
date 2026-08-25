/**
 * Un filtro puntato su qualcosa che non è una lista.
 *
 * Il 2026-08-16 il wizard ha consegnato «Email con parole chiave» così:
 *
 *     trigger_imap → action_filter → community_telegram
 *
 * `trigger_imap` produce UN messaggio; `action_filter` filtra ARRAY. Con un
 * ingresso che array non è, il filtro lavora su zero elementi, non ne fa
 * passare nessuno — e i nodi a valle partono lo stesso. L'avviso su Telegram
 * sarebbe arrivato per ogni email, che è il contrario di quello che era stato
 * chiesto.
 *
 * La regola gemella sta nel motore (`rule-lista-che-non-arriva.ts`), dove
 * rifiuta e fa rigenerare. Qui serve a chi disegna a mano: il canvas non deve
 * accettare in silenzio quello che il generatore rifiuta.
 *
 * ── Perché non blocca lavoro legittimo ──
 *
 * Non indovina: confronta i campi su cui il filtro dice di filtrare con quelli
 * che il nodo a monte dice di produrre. Le regole si applicano agli ELEMENTI:
 * se `subject` è invece un campo di primo livello di chi sta a monte, quel nodo
 * produce un record, non un elenco. Chi filtra le righe di una query per una
 * colonna non tocca nessun nome dichiarato, e la regola tace — come tace dove
 * manca il contratto o le regole non si leggono.
 *
 * @module features/workflows/quality/rules-liste
 */

import type { QualityGateInput, QualityIssue, QualityNodeDef } from './types';

/** I campi con cui un nodo dichiara DOVE prendere la lista. */
const CAMPI_CHE_INDICANO_LA_SORGENTE: ReadonlySet<string> = new Set(['items', 'sourceExpression']);

/** I campi su cui il nodo dice di filtrare, comunque li abbia scritti. */
function campiDelleRegole(config: Record<string, unknown>): string[] {
  const grezzo = config.conditions ?? config.conditionRules;
  if (typeof grezzo !== 'string' || grezzo.trim() === '') return [];

  let letto: unknown;
  try {
    letto = JSON.parse(grezzo);
  } catch {
    return [];
  }
  const regole = Array.isArray(letto)
    ? letto
    : letto !== null &&
        typeof letto === 'object' &&
        Array.isArray((letto as { rules?: unknown }).rules)
      ? (letto as { rules: unknown[] }).rules
      : [];

  const nomi: string[] = [];
  for (const r of regole) {
    if (r === null || typeof r !== 'object') continue;
    const regola = r as { field?: unknown; left?: unknown };
    const grezza = typeof regola.field === 'string' ? regola.field : regola.left;
    if (typeof grezza !== 'string') continue;
    // `subject`, `{{$node.imap.json.subject}}` e `messaggio.subject` puntano
    // tutti allo stesso nome: conta l'ultimo pezzo.
    const pulito = grezza.replace(/[{}]/g, '').trim().split('.').pop();
    if (pulito !== undefined && pulito !== '') nomi.push(pulito);
  }
  return nomi;
}

/** Vero se il nodo ha detto lui dove prendere la lista. */
function haUnaSorgentePropria(config: Record<string, unknown>): boolean {
  for (const chiave of CAMPI_CHE_INDICANO_LA_SORGENTE) {
    const v = config[chiave];
    // `input` è il valore predefinito e significa «quello che mi arriva».
    if (typeof v === 'string' && v.trim() !== '' && v.trim() !== 'input') return true;
  }
  return false;
}

/** Che cosa dice il nodo a monte: `false` sbagliato, `true` va bene, `null` non si sa. */
function verdettoSuMonte(
  def: QualityNodeDef | undefined,
  campiRegola: readonly string[],
): boolean | null {
  const campi = def?.outputContract?.fields;
  if (campi === undefined) return null;

  const perNome = new Map(campi.map((c) => [c.name.toLowerCase(), (c.type ?? '').toLowerCase()]));

  if (campiRegola.length > 0) {
    const tuttiSuoi = campiRegola.every((n) => {
      const tipo = perNome.get(n.toLowerCase());
      return tipo !== undefined && !tipo.includes('array');
    });
    if (tuttiSuoi) return false;
  }

  return campi.some((c) => (c.type ?? '').toLowerCase().includes('array'));
}

export function checkListaCheNonArriva(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const defPerNodo = new Map(input.nodes.map((n) => [n.id, input.defs?.get(n.defId)]));

  for (const node of input.nodes) {
    const def = input.defs?.get(node.defId);
    // Senza definizione non si sa nemmeno se lavora su liste: si tace.
    if (!def) continue;
    if (!(def.configFields ?? []).some((f) => CAMPI_CHE_INDICANO_LA_SORGENTE.has(f.key))) continue;
    if (haUnaSorgentePropria(node.config)) continue;

    const monte = input.edges.filter((e) => e.to === node.id).map((e) => e.from);
    if (monte.length === 0) continue;

    const campiRegola = campiDelleRegole(node.config);
    const verdetti = monte.map((id) => verdettoSuMonte(defPerNodo.get(id), campiRegola));
    // Basta un dubbio — o una lista vera — perché la regola taccia.
    if (verdetti.some((v) => v === null || v)) continue;

    const nomi = monte.map((id) => `«${id}»`).join(', ');
    issues.push({
      severity: 'critical',
      code: 'LISTA_CHE_NON_ARRIVA',
      nodeId: node.id,
      message:
        `«${node.id}» filtra un elenco, ma da ${nomi} arriva un solo elemento: i campi su cui ` +
        'filtra sono i campi di quel record, non di una lista. Il filtro non farebbe passare ' +
        'niente, e i nodi collegati partirebbero lo stesso — cioè scatterebbero SEMPRE, anche ' +
        'quando la condizione non è vera. Per decidere su un singolo elemento usa il nodo ' +
        '«Condizione» (logic_if) e collega il ramo «vero» a quello che deve succedere.',
    });
  }
  return issues;
}
