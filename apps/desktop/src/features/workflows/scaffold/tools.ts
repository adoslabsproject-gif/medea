/**
 * I 9 tool dell'agente che costruisce e modifica i workflow.
 *
 * Nomi, descrizioni e schema dei parametri sono **identici all'originale**:
 * il dataset di addestramento è costruito su questi, quindi rinominarne uno o
 * cambiarne un parametro disallineerebbe il modello dagli strumenti che
 * riceve. Si aggiungono capacità, non si toccano queste.
 */

import { ordinaPerPertinenza } from '../catalog/punteggio';
import { describeIssues, type QualityDatabase } from '../quality';
import type { NodeDef } from '../types';

import type { WorkflowBuilder, WorkflowSnapshot } from './builder';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema esposto al modello. */
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  builder: WorkflowBuilder;
  catalog: NodeDef[];
  /** Schema dei database disponibili: abilita i controlli su tabelle e
   *  colonne quando l'app lo conosce. */
  databases?: readonly QualityDatabase[];
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const WORKFLOW_AGENT_TOOLS: ToolDef[] = [
  {
    name: 'analyze_goal',
    description:
      "PRIMO passo, prima di qualunque ricerca: scomponi la richiesta dell'utente nelle sue tre parti. " +
      'Serve a decidere COSA cercare invece di cercare le parole della richiesta. ' +
      'Chiamalo una volta sola, all’inizio.',
    parameters: obj(
      {
        whenItStarts: {
          type: 'string',
          description:
            'Cosa fa partire il workflow, in una frase: a orario, all’arrivo di una email, su chiamata esterna, a mano.',
        },
        whatItDoes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Le azioni in ordine, una per voce, dette come gesti: «sposta le email in una cartella», «conta quante», «manda un riepilogo».',
        },
        conditions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filtri, rami e ripetizioni, se ce ne sono: «solo quelle più vecchie di 30 giorni», «per ogni allegato». Lista vuota se non servono.',
        },
      },
      ['whenItStarts', 'whatItDoes'],
    ),
  },
  {
    name: 'search_nodes',
    description:
      'Cerca nel catalogo i nodi pertinenti a una descrizione (es. "invia email", "http get", "salva in database"). Usalo PRIMA di add_node per scegliere il defId giusto.',
    parameters: obj({ query: { type: 'string', description: 'Cosa deve fare il nodo' } }, [
      'query',
    ]),
  },
  {
    name: 'get_node_schema',
    description:
      'Restituisce i campi di configurazione di un nodo (chiavi, tipo, obbligatorietà, valori enum) e le sue azioni. Usalo prima di configurare un nodo.',
    parameters: obj({ defId: { type: 'string' } }, ['defId']),
  },
  {
    name: 'add_node',
    description:
      "Aggiunge un nodo al workflow. Il defId DEVE esistere nel catalogo (usa search_nodes). Ritorna l'id assegnato e gli eventuali campi obbligatori ancora da configurare.",
    parameters: obj(
      {
        defId: { type: 'string' },
        id: { type: 'string', description: 'Opzionale: id leggibile. Se omesso è auto-generato.' },
        config: { type: 'object', description: 'Config iniziale (opzionale).' },
      },
      ['defId'],
    ),
  },
  {
    name: 'connect',
    description:
      'Collega due nodi già aggiunti (from → to). Per i nodi a rami (if/switch) specifica fromPort.',
    parameters: obj(
      { from: { type: 'string' }, to: { type: 'string' }, fromPort: { type: 'string' } },
      ['from', 'to'],
    ),
  },
  {
    name: 'set_config',
    description:
      'Imposta o aggiorna la config di un nodo esistente. merge:true fonde coi valori esistenti, merge:false rimpiazza.',
    parameters: obj(
      { nodeId: { type: 'string' }, config: { type: 'object' }, merge: { type: 'boolean' } },
      ['nodeId', 'config'],
    ),
  },
  {
    name: 'delete_node',
    description:
      'Rimuove un nodo dal workflow E tutti i suoi collegamenti (in entrata e uscita). Usalo per MODIFICARE un workflow esistente quando un nodo non serve più.',
    parameters: obj({ nodeId: { type: 'string' } }, ['nodeId']),
  },
  {
    name: 'disconnect',
    description:
      'Rimuove un collegamento esistente tra due nodi (from → to), lasciando i nodi al loro posto. Per i rami (if/switch) specifica fromPort.',
    parameters: obj(
      { from: { type: 'string' }, to: { type: 'string' }, fromPort: { type: 'string' } },
      ['from', 'to'],
    ),
  },
  {
    name: 'validate_workflow',
    description:
      'Verifica il workflow corrente: campi obbligatori mancanti, enum invalidi, edge orfani. Usalo prima di finish.',
    parameters: obj({}),
  },
  {
    name: 'finish',
    description:
      'Termina la costruzione e restituisce il workflow finale. Chiamalo quando il workflow è completo e validato.',
    parameters: obj({}),
  },
];

/**
 * I nodi che corrispondono a quello che il modello sta cercando.
 *
 * Usa lo stesso punteggio della palette: erano due ricerche diverse, e questa
 * era la più grezza — ogni parola valeva uno se compariva ovunque, con il
 * risultato che un nodo dalla descrizione lunga batteva quello giusto. Il
 * modello ci costruiva sopra il workflow, e non aveva torto: gli avevamo detto
 * noi che quello era il nodo più pertinente.
 *
 * Ne restituisce venti e non otto: il modello sceglie meglio se vede le
 * alternative, e otto righe di catalogo costano meno di un workflow sbagliato.
 */
function searchNodes(catalog: NodeDef[], query: string, limit = 20): unknown[] {
  return ordinaPerPertinenza(catalog, query, limit).map((def) => ({
    defId: def.defId,
    label: def.label,
    type: def.type,
    // La descrizione serve a distinguere due nodi che si chiamano quasi
    // uguale: senza, il modello sceglie a caso fra «Email: invia» e
    // «Email: invia con tracking».
    description: def.description,
  }));
}

/** Estrattori difensivi: se il modello passa un oggetto dove serve una
 *  stringa, meglio un valore vuoto che "[object Object]" salvato nel config. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function cfg(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface ToolCallResult {
  /** Il risultato che torna al modello. */
  data: unknown;
  /** `true` solo per `finish`: il loop si ferma. */
  done?: boolean;
  snapshot?: WorkflowSnapshot;
}

/** Esegue un tool sul workflow in costruzione. */
export function executeWorkflowTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): ToolCallResult {
  switch (name) {
    case 'analyze_goal': {
      // Non tocca il workflow: serve a fissare l'intenzione prima di cercare,
      // e a farla vedere a chi guarda. Si risponde con quello che è stato
      // capito, così il modello ha davanti la propria analisi al passo dopo.
      const quando = str(args.whenItStarts);
      const cosa = Array.isArray(args.whatItDoes) ? args.whatItDoes.map((v) => str(v)) : [];
      const condizioni = Array.isArray(args.conditions) ? args.conditions.map((v) => str(v)) : [];
      return {
        data: {
          understood: { whenItStarts: quando, whatItDoes: cosa, conditions: condizioni },
          next: 'Ora cerca un nodo per ciascuna voce di whatItDoes con search_nodes, cercando il gesto e non le parole della richiesta.',
        },
      };
    }
    case 'search_nodes': {
      const query = str(args.query);
      return { data: { hits: searchNodes(ctx.catalog, query) } };
    }
    case 'get_node_schema': {
      const defId = str(args.defId);
      const def = ctx.catalog.find((c) => c.defId === defId);
      if (!def) return { data: { error: `defId "${defId}" non trovato. Usa search_nodes.` } };
      return {
        data: {
          defId: def.defId,
          label: def.label,
          fields: (def.configFields ?? []).map((f) => ({
            key: f.key,
            type: f.type,
            required: f.required ?? false,
            ...(f.options ? { options: f.options } : {}),
            ...(f.defaultValue ? { defaultValue: f.defaultValue } : {}),
          })),
          ...(def.actions
            ? { actions: def.actions.map((a) => ({ id: a.id, label: a.label })) }
            : {}),
          ...(def.outputPorts ? { outputPorts: def.outputPorts } : {}),
        },
      };
    }
    case 'add_node':
      return {
        data: ctx.builder.addNode(str(args.defId), optStr(args.id), cfg(args.config)),
      };
    case 'connect':
      return {
        data: ctx.builder.connect(str(args.from), str(args.to), optStr(args.fromPort)),
      };
    case 'set_config':
      return {
        data: ctx.builder.setConfig(
          str(args.nodeId),
          cfg(args.config),
          args.merge === undefined ? true : Boolean(args.merge),
        ),
      };
    case 'delete_node':
      return { data: ctx.builder.deleteNode(str(args.nodeId)) };
    case 'disconnect':
      return {
        data: ctx.builder.disconnect(str(args.from), str(args.to), optStr(args.fromPort)),
      };
    case 'validate_workflow': {
      const violations = ctx.builder.validate();
      const orphans = ctx.builder.orphanNodes();
      // Il gate di qualità entra qui e non solo alla fine: se il modello
      // scopre il segnaposto mentre costruisce, lo corregge subito invece di
      // arrivare a `finish` e vedersi respingere tutto.
      const quality = ctx.builder.quality(ctx.databases);
      const blocking = quality.issues.filter((i) => i.severity !== 'info');
      return {
        data: {
          valid: violations.length === 0 && orphans.length === 0 && !quality.shouldReject,
          issues: [...violations.map((v) => v.message), ...describeIssues(blocking)],
          ...(orphans.length > 0 ? { orphanNodes: orphans } : {}),
        },
      };
    }
    case 'finish': {
      const violations = ctx.builder.validate();
      const quality = ctx.builder.quality(ctx.databases);
      return {
        done: true,
        snapshot: ctx.builder.snapshot(),
        data: {
          remainingIssues: [
            ...violations.map((v) => v.message),
            ...describeIssues(quality.issues.filter((i) => i.severity !== 'info')),
          ],
        },
      };
    }
    default:
      return { data: { error: `Tool "${name}" non esiste.` } };
  }
}
