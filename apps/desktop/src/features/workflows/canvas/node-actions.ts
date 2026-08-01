/**
 * I nodi che contengono molte operazioni.
 *
 * Un pacchetto di comunità — Telegram, PDF4Me — non è un nodo per operazione:
 * è **un** nodo che ne dichiara fino a settantacinque. Quale si esegue lo dice
 * `config.__action`, e i campi da compilare cambiano con la scelta.
 *
 * Senza una scelta esplicita quei nodi sono inconfigurabili: si trascinano sul
 * disegno e non c'è modo di dire cosa devono fare.
 *
 * Qui c'è solo la logica — raggruppare, filtrare, capire quale azione è
 * scelta. Il disegno sta in `NodeActionPicker`.
 */

import type { NodeAction, NodeConfigField, NodeDef } from '../types';

/** La chiave in cui il motore si aspetta di trovare l'operazione scelta. */
export const ACTION_KEY = '__action';

/** Vero per i nodi che raccolgono più operazioni sotto un nome solo. */
export function hasActions(def: NodeDef | undefined): boolean {
  return (def?.actions?.length ?? 0) > 0;
}

/**
 * L'operazione scelta, o la prima se non si è ancora scelto.
 *
 * Non lasciarne nessuna selezionata significherebbe mostrare un pannello
 * vuoto: meglio partire dalla prima e lasciare che si cambi.
 */
export function currentAction(
  def: NodeDef | undefined,
  config: Record<string, unknown>,
): NodeAction | undefined {
  const actions = def?.actions ?? [];
  const chosen = config[ACTION_KEY];
  if (typeof chosen === 'string') {
    const found = actions.find((a) => a.id === chosen);
    if (found) return found;
  }
  return actions[0];
}

/**
 * I campi da mostrare: quelli del nodo più quelli dell'operazione scelta.
 *
 * L'ordine conta: prima quelli che valgono sempre — un token, un indirizzo —
 * poi quelli che dipendono da cosa si è scelto di fare.
 */
export function fieldsFor(
  def: NodeDef | undefined,
  config: Record<string, unknown>,
): NodeConfigField[] {
  const shared = def?.configFields ?? [];
  if (!hasActions(def)) return [...shared];
  return [...shared, ...(currentAction(def, config)?.configFields ?? [])];
}

export interface ActionGroup {
  /** Il nome del gruppo. Vuoto quando le operazioni non sono raggruppate. */
  label: string;
  actions: NodeAction[];
}

/** Il testo su cui si cerca un'operazione. */
function haystack(action: NodeAction): string {
  return `${action.id} ${action.label ?? ''} ${action.description ?? ''}`.toLowerCase();
}

/**
 * Le operazioni raggruppate e filtrate, pronte da elencare.
 *
 * Con settantacinque voci una lista piatta è inutilizzabile: si cerca. E
 * quando non si cerca, i gruppi danno almeno un ordine in cui guardare.
 */
export function groupActions(actions: readonly NodeAction[], query = ''): ActionGroup[] {
  const terms = query.trim().toLowerCase();
  const filtered = terms ? actions.filter((a) => haystack(a).includes(terms)) : [...actions];

  const byGroup = new Map<string, NodeAction[]>();
  for (const action of filtered) {
    const label = action.category ?? action.resource ?? '';
    const list = byGroup.get(label) ?? [];
    list.push(action);
    byGroup.set(label, list);
  }

  return (
    [...byGroup]
      .map(([label, list]) => ({ label, actions: list }))
      // I raggruppati prima, quelli senza gruppo in fondo: se un pacchetto
      // dichiara categorie a metà, le voci sciolte non spezzano l'elenco.
      .sort((a, b) => (a.label === '' ? 1 : b.label === '' ? -1 : a.label.localeCompare(b.label)))
  );
}
