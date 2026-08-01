/**
 * Schema del workflow — port di `packages/flowforge/core/schema` di FlowForge.
 *
 * Vincolo: un workflow generato qui deve poter essere importato sul server e
 * viceversa. Ogni deviazione da questa forma rompe la compatibilità.
 */

import type { ShowIfRule } from './fields/show-if';

/** Nodo sul canvas. I valori di config sono normalizzati a stringa: è il
 *  motore a farne il parse a runtime (stessa scelta del server). */
export interface CanvasNode {
  id: string;
  defId: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
  name?: string;
  label?: string;
  continueOnFail?: boolean;
  defVersion?: string;
}

/** Collegamento fra due nodi.
 *  `fromPort` conta per i nodi che ramificano (`logic_if` → `true`/`false`).
 *  `sourceHandle`/`targetHandle` sono solo UI: il motore li ignora.
 *  `mapMode` è il fan-out per elemento senza loop esplicito. */
export interface WorkflowEdge {
  from: string;
  to: string;
  fromPort?: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  mapMode?: 'off' | 'auto' | 'each';
}

/** Colonna di una tabella che il workflow chiede di creare. */
export interface TableColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TableToCreate {
  name: string;
  columns: TableColumn[];
}

/** Il workflow incorpora le definizioni dei nodi che usa: un JSON esportato
 *  è autodescrittivo e si apre anche dove quei nodi non sono installati. */
export interface Workflow {
  id?: string;
  name: string;
  description?: string;
  nodes: CanvasNode[];
  edges: WorkflowEdge[];
  nodeDefs?: NodeDef[];
  /** Come lo conosce il runtime, quando gli è già stato mandato. Serve a non
   *  creargliene una copia nuova a ogni esecuzione. */
  runtimeId?: string;
  runVerbosity?: 'silent' | 'summary' | 'full';
  /**
   * Dove viene eseguito. In Medea è **sempre** `local`: il workflow gira sul
   * computer dell'utente, che è l'unico posto da cui si vede la sua posta, e
   * non esiste un account sul server dove ospitarlo — il server fa solo da
   * relay per i webhook in ingresso (ADR 0005).
   *
   * Il campo resta perché fa parte del formato condiviso con FlowForge: un
   * workflow importato da là può dichiarare `server`, e riesportandolo deve
   * ritrovarsi come l'ha lasciato.
   */
  executionTarget?: 'local' | 'server';
}

/** Un campo di configurazione di un nodo, con i vincoli che il modello deve
 *  rispettare. È la fonte da cui nascono sia il prompt sia la validazione. */
export interface NodeConfigField {
  key: string;
  label?: string;
  type: string;
  required?: boolean;
  options?: string[];
  pattern?: string;
  /** Cosa dire quando il valore non rispetta il pattern. Senza, il messaggio
   *  d'errore è l'espressione regolare — che non aiuta nessuno. */
  patternMessage?: string;
  defaultValue?: string;
  /**
   * In che lingua è scritto un campo di codice.
   *
   * La usano la regola di qualità `CODE_NODE_LANG_MISMATCH` — che si accorge
   * di uno `SELECT` dentro un campo JavaScript — e l'editor per evidenziare.
   * Senza, un blocco SQL e uno JavaScript sono la stessa casella grigia.
   */
  language?: 'javascript' | 'typescript' | 'json' | 'yaml' | 'sql' | 'jsonata';
  description?: string;
  /** Il testo di esempio dentro il campo vuoto. */
  placeholder?: string;
  /** Mostra il campo solo quando un altro campo ha un certo valore. */
  showIf?: ShowIfRule;
  /** Il campo di cui questo elenco dipende (es. la tabella dipende dal database). */
  dependsOn?: string;
}

export interface NodeAction {
  id: string;
  label?: string;
  description?: string;
  /** Il gruppo in cui l'operazione compare nell'elenco. */
  category?: string;
  /** La risorsa su cui agisce, nel modello risorsa/operazione. */
  resource?: string;
  /** Vero per le operazioni che si appoggiano a un modello. */
  aiAction?: boolean;
  /** I campi che compaiono solo quando è scelta questa operazione. */
  configFields?: NodeConfigField[];
}

/**
 * Cosa produce davvero un nodo, campo per campo.
 *
 * Serve a non far inventare all'assistente i nomi delle chiavi quando scrive
 * `{{$node.x.json.qualcosa}}`: senza, sui casi limite tira a indovinare — un
 * `partnerId: 0` al posto del `null` che il nodo restituisce sul serio.
 */
export interface OutputContract {
  fields: { name: string; type?: string; description?: string }[];
  /** Note che valgono su più campi insieme, tipo «se non trova nulla, tutti null». */
  notes?: string;
}

/** Definizione di un nodo del catalogo. */
export interface NodeDef {
  defId: string;
  type: 'trigger' | 'action' | 'ai' | 'logic';
  label: string;
  description?: string;
  /** Nome simbolico dell'icona dichiarato dal nodo (es. `clock`, `mail`). */
  icon?: string;
  /** Colore identificativo del nodo, come lo definisce il suo pacchetto. */
  color?: string;
  configFields?: NodeConfigField[];
  actions?: NodeAction[];
  /**
   * Vero per i nodi che scelgono una strada: `logic_if`, `logic_switch`,
   * `logic_loop`. Solo questi hanno più porte in uscita.
   */
  branching?: boolean;
  /** Le porte in uscita, per i nodi che ramificano (`true`/`false`). */
  outputPorts?: string[];
  /**
   * I campi che il nodo produce. **Non sono porte**: sono le chiavi del suo
   * risultato, quelle che si leggono con `{{$node.x.json.campo}}`. Un nodo
   * con diciassette campi non ha diciassette strade in uscita: ne ha una.
   */
  outputFields?: string[];
  /**
   * Le parole con cui un nodo si cerca ma che nel suo nome non compaiono:
   * «wa» per WhatsApp, «posta» per email. Senza, la ricerca trova solo chi
   * già sa come si chiama la cosa che sta cercando.
   */
  searchAliases?: string[];
  /**
   * La versione della **definizione**, non del pacchetto.
   *
   * È quella che permette di accorgersi che un workflow salvato mesi fa usa
   * un nodo cambiato da allora. Senza, la deriva passa inosservata finché
   * qualcosa non smette di funzionare senza motivo apparente.
   */
  defVersion?: string;
  /** La descrizione per esteso, quando dice più della prima frase. La palette
   *  mostra `description`; questa serve all'assistente per scegliere. */
  descriptionLong?: string;
  outputContract?: OutputContract;
  /** Il nodo si riprova da sé: il motore non deve rifarlo, e il pannello dei
   *  tentativi non deve offrirlo. */
  selfManagedRetry?: boolean;
}
