/**
 * Il loop dell'agente: costruisce il workflow un passo alla volta.
 *
 * A differenza della generazione in un colpo solo, qui il modello **vede il
 * catalogo mentre lavora**: cerca il nodo, ne legge lo schema, lo aggiunge,
 * lo configura, valida e chiude. È il motivo per cui funziona anche con un
 * provider che non conosce i nodi: non deve ricordarli, li interroga.
 *
 * È anche l'unica modalità che sa MODIFICARE un workflow esistente, partendo
 * dal suo stato invece di rigenerarlo da capo.
 */

import { describeIssues, type QualityDatabase, type QualityIssue } from '../quality';
import type { NodeDef, Workflow } from '../types';

import { WorkflowBuilder, type WorkflowSnapshot } from './builder';
import { executeWorkflowTool, WORKFLOW_AGENT_TOOLS } from './tools';
import type { Violation } from './validate';

/** Oltre questo numero di passi si ferma: un modello che gira a vuoto non
 *  deve poter consumare all'infinito. */
/** Quanti passi al massimo prima di arrendersi. Esposto perché l'interfaccia
 *  possa dire «passo 3 di 40» invece di un numero senza scala. */
export const AGENT_MAX_STEPS = 40;
const MAX_STEPS = AGENT_MAX_STEPS;

/** Quante volte gli si può dire «no, non è pronto» prima di arrendersi. Un
 *  modello che non capisce al terzo richiamo non capirà al quarto. */
const MAX_PUSHBACKS = 3;

/**
 * Quante volte si accetta che il modello risponda a parole invece di usare
 * gli strumenti, prima di dire che non ce la fa.
 *
 * Non è pignoleria: un modello che non emette chiamate nel formato atteso non
 * comincerà a farlo al decimo tentativo. Senza questo limite il ciclo gli
 * ripeteva «usa gli strumenti» per tutti e quaranta i passi e poi si arrendeva
 * con «non ha concluso entro 40 passi» — un messaggio che manda a cercare il
 * problema nella richiesta dell'utente, che non c'entra niente.
 */
const MAX_RISPOSTE_A_VUOTO = 3;

/** Chiamata a tool emessa dal modello, nella forma normalizzata dal backend. */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTurn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  toolCallId?: string;
  name?: string;
}

/** Il canale verso il modello. Astratto: l'agente non sa quale provider ci sia. */
export type AgentChat = (args: {
  system: string;
  history: AgentTurn[];
  tools: { type: 'function'; function: Record<string, unknown> }[];
}) => Promise<{ content: string; toolCalls: AgentToolCall[] }>;

export interface AgentStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface AgentSuccess {
  ok: true;
  workflow: Workflow;
  steps: AgentStep[];
  /** Problemi rimasti che l'utente dovrà sistemare a mano (es. scelte da menu). */
  remainingIssues: string[];
}

export interface AgentFailure {
  ok: false;
  steps: AgentStep[];
  reason: string;
  violations: Violation[];
  /** I problemi di qualità che hanno concorso al rifiuto. */
  qualityIssues: QualityIssue[];
  /** Lo stato raggiunto: anche incompleto può valere la pena mostrarlo. */
  partial?: WorkflowSnapshot;
}

export type AgentResult = AgentSuccess | AgentFailure;

export interface AgentRequest {
  goal: string;
  catalog: NodeDef[];
  chat: AgentChat;
  /** Workflow da modificare invece di crearne uno nuovo. */
  seed?: Workflow;
  /** Risorse reali: database, account email, credenziali disponibili. */
  context?: string;
  /** Schema dei database noti: accende i controlli su tabelle e colonne. */
  databases?: readonly QualityDatabase[];
  onStep?: (step: AgentStep) => void;
  /** Con questo si può fermare il ciclo a metà: viene guardato prima di ogni
   *  passo, e chi lo aziona ferma anche la chiamata in volo. */
  signal?: AbortSignal;
}

export function buildAgentSystemPrompt(goal: string, context?: string, isModify = false): string {
  return [
    'Sei un ingegnere di automazione che costruisce workflow usando gli strumenti a disposizione.',
    '',
    isModify
      ? 'Stai MODIFICANDO un workflow esistente: leggilo prima di cambiarlo, e tocca solo ciò che serve.'
      : 'Costruisci il workflow UN PASSO ALLA VOLTA, non tutto in una volta:',
    '',
    // Prima di cercare, decidere cosa cercare. Un modello che parte da
    // `search_nodes` con le parole della richiesta trova quello che a quelle
    // parole somiglia, non quello che serve: chiedendo di archiviare delle
    // newsletter finisce sull'archiviazione a norma delle PEC. Nominare le
    // tre parti prima di muoversi restringe lo spazio in cui sbagliare, e
    // serve soprattutto ai modelli che questo catalogo non l'hanno mai visto.
    // L'analisi passa da uno strumento e non da una risposta a parole. Non è
    // una finezza: il ciclo si aspetta chiamate a ogni giro, e un modello che
    // si ferma a scrivere viene contato come uno che non sta lavorando. Con
    // uno strumento l'analisi è un passo come gli altri — si vede nel
    // pannello, resta nella cronologia, e vale per qualunque modello.
    'FASE 1 — CAPIRE. `analyze_goal` PER PRIMO, sempre, prima di ogni ricerca.',
    '  Scompone la richiesta in quando parte, cosa fa e a quali condizioni.',
    '  Non rispondere a parole: chiama lo strumento.',
    '',
    'FASE 2 — SCEGLIERE. `search_nodes` per ogni parte, una ricerca alla volta.',
    '  Cerca il GESTO, non le parole della richiesta: per «archivia le newsletter»',
    '  cerca «sposta email cartella», non «newsletter». Leggi le descrizioni dei',
    '  risultati prima di scegliere: due nodi possono chiamarsi quasi uguale e fare',
    '  cose diverse. `get_node_schema` sul nodo scelto, prima di configurarlo.',
    '',
    'FASE 3 — MONTARE. `add_node` per ogni nodo deciso, partendo dal trigger.',
    '',
    'FASE 4 — COLLEGARE. `connect` nell’ordine del flusso: trigger → azioni.',
    '',
    'FASE 5 — CONFIGURARE. `set_config` per i campi obbligatori di ogni nodo.',
    '',
    'FASE 6 — VERIFICARE. `validate_workflow`, e correggi quello che segnala.',
    '',
    'FASE 7 — CHIUDERE. `finish`, SOLO quando validate_workflow non riporta più problemi.',
    '',
    'Regole:',
    '- Rispondi SEMPRE chiamando uno strumento. Non scrivere spiegazioni: ogni',
    '  passo è una chiamata, e il primo è `analyze_goal`.',
    // Il modello, lasciato libero, si ferma a chiedere: quale cartella, quale
    // indirizzo, quale soglia. Sono domande sensate — e non c'è nessuno che
    // possa rispondere, perché dall'altra parte del ciclo non c'è una
    // conversazione. Il risultato è che le ripete finché ci si arrende, e
    // l'utente legge che il modello «non sa usare gli strumenti».
    '- NON fare domande e NON chiedere conferme: nessuno può risponderti.',
    '  Se un dato manca, scegli il valore più ragionevole e vai avanti — una',
    '  cartella «Newsletter», un indirizzo `{{secrets.EMAIL_DESTINATARIO}}`,',
    '  una soglia dedotta dalla richiesta. Chi guarda correggerà quello che',
    '  non gli va: un workflow completo da correggere vale più di una domanda',
    '  senza risposta.',
    '- Inizia SEMPRE da un nodo trigger.',
    '- Riempi i campi obbligatori con valori realistici dedotti dal goal; i segreti',
    '  (API key, password) vanno come `{{secrets.NOME}}`.',
    "- Per riferire l'output di un nodo precedente usa espressioni `{{$node.<id>.json.<campo>}}`.",
    '- Non aggiungere nodi inutili: il minimo che realizza il goal.',
    '',
    `GOAL: ${goal}`,
    ...(context?.trim() ? ['', 'CONTESTO:', context.trim()] : []),
  ].join('\n');
}

/** I tool nel formato che il backend passa al provider. */
export function agentToolsForProvider(): { type: 'function'; function: Record<string, unknown> }[] {
  return WORKFLOW_AGENT_TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Che cosa dire a chi si è fermato: il passo dopo, non quello appena fatto.
 *
 * Si guarda cosa ha già chiamato e si indica la mossa che manca. Un richiamo
 * generico — «usa gli strumenti» — è inutile a chi gli strumenti li sta già
 * usando ma si è bloccato a metà; e un richiamo che nomina un passo già
 * compiuto è peggio che inutile, perché lo fa ripetere.
 */
function prossimoPasso(steps: readonly AgentStep[], montati: number): string {
  const fatti = new Set(steps.map((s) => s.tool));

  if (montati === 0) {
    if (!fatti.has('analyze_goal')) {
      return 'Comincia da `analyze_goal`, che scompone la richiesta nelle sue parti.';
    }
    if (!fatti.has('search_nodes')) {
      return 'Hai già scomposto la richiesta. Adesso chiama `search_nodes` per la prima azione: cerca il gesto, non le parole della richiesta.';
    }
    return 'Hai già cercato. Adesso chiama `add_node` con il defId che hai trovato, cominciando dal trigger.';
  }

  if (!fatti.has('connect')) {
    return `Hai ${String(montati)} nodi sul disegno e nessun collegamento: chiama \`connect\` per unirli nell'ordine del flusso.`;
  }
  if (!fatti.has('validate_workflow')) {
    return `Hai ${String(montati)} nodi collegati: chiama \`validate_workflow\` per vedere cosa manca.`;
  }
  return 'Hai già validato: correggi quello che è stato segnalato con `set_config`, poi chiama `finish`.';
}

export async function runWorkflowAgent(req: AgentRequest): Promise<AgentResult> {
  const builder = new WorkflowBuilder(
    req.catalog,
    req.seed?.name ?? 'Nuovo workflow',
    req.seed?.description,
    req.seed ? { nodes: req.seed.nodes, edges: req.seed.edges } : undefined,
  );
  const ctx = {
    builder,
    catalog: req.catalog,
    ...(req.databases ? { databases: req.databases } : {}),
  };
  const system = buildAgentSystemPrompt(req.goal, req.context, Boolean(req.seed));
  const tools = agentToolsForProvider();

  const history: AgentTurn[] = [{ role: 'user', content: req.goal }];
  const steps: AgentStep[] = [];
  let pushbacks = 0;
  /** Risposte senza nemmeno una chiamata a uno strumento. */
  /**
   * Risposte a parole **di fila**. Il conto si azzera appena il modello torna
   * a chiamare uno strumento: chi alterna una spiegazione e un'azione sta
   * lavorando, e sommare quelle spiegazioni lungo tutta la costruzione voleva
   * dire fermare un modello che stava arrivando in fondo. Solo chi si blocca
   * davvero fa tre giri a vuoto uno dopo l'altro.
   */
  let aVuoto = 0;

  for (let step = 1; step <= MAX_STEPS; step++) {
    // Fermato: si esce con quello che si è costruito fin qui, che è più utile
    // di niente — i nodi già messi restano, e si vede dove si era arrivati.
    if (req.signal?.aborted) {
      return failFrom(builder, steps, 'Interrotto.', req.databases);
    }
    let reply: { content: string; toolCalls: AgentToolCall[] };
    try {
      reply = await req.chat({ system, history, tools });
    } catch (e) {
      return failFrom(builder, steps, `Il provider non ha risposto: ${String(e)}`, req.databases);
    }

    if (reply.toolCalls.length === 0) {
      // Nessuno strumento chiamato: o ha finito senza dirlo, o si è perso.
      // Glielo si fa notare una volta, poi si chiude.
      const assessment = assess(builder, req.databases);
      if (builder.snapshot().nodes.length > 0 && assessment.blocking.length === 0) {
        return finishFrom(builder, steps, req.databases);
      }
      aVuoto++;
      // La risposta finisce nella cronologia anche quando non contiene
      // chiamate. È l'unico modo per sapere *cosa* ha detto il modello invece
      // di lavorare: senza, il pannello dice «ha risposto a parole» e chi
      // guarda non ha niente su cui ragionare — né l'utente né chi deve
      // sistemare il prompt.
      const risposta: AgentStep = {
        step,
        tool: '(risposta a parole)',
        args: { attesi: 'una chiamata a uno strumento' },
        result: { testo: reply.content.slice(0, 2000) },
      };
      steps.push(risposta);
      req.onStep?.(risposta);
      // Il richiamo è più utile se dice cosa fare adesso, non in generale: un
      // modello che si è fermato al primo giro va rimandato all'analisi, uno
      // che ha già montato dei nodi va rimandato a chiudere.
      const montatiFinora = builder.snapshot().nodes.length;
      if (aVuoto >= MAX_RISPOSTE_A_VUOTO) {
        return failFrom(
          builder,
          steps,
          `Il modello ha risposto ${String(aVuoto)} volte di fila a parole senza usare gli strumenti: ` +
            'non sta pilotando la costruzione. Di solito vuol dire che il modello scelto non ' +
            'sa chiamare gli strumenti, o che il provider non li sta passando. ' +
            'Prova con un altro modello in Impostazioni → Modelli AI.',
          req.databases,
        );
      }
      history.push(
        { role: 'assistant', content: reply.content },
        {
          role: 'user',
          content: [
            'Non hai chiamato nessuno strumento.',
            // Se la risposta contiene un punto interrogativo, quasi sempre il
            // modello ha chiesto qualcosa. Rispondergli «usa gli strumenti»
            // non lo sblocca: gli si deve dire che la domanda non avrà mai
            // risposta e che deve decidere da solo.
            // Il caso più insidioso: il modello racconta di aver fatto una
            // cosa che non ha fatto — «Collegamenti pronti: email come
            // trigger verso l'archivio». Descrive l'azione al posto di
            // eseguirla, e sul disegno non è cambiato niente. Va detto senza
            // giri di parole, perché altrimenti continua a raccontare.
            ...(/collegament\w* pronti|ho collegato|ho configurato|ho aggiunto|adesso collego|controllo il workflow/i.test(
              reply.content,
            )
              ? [
                  'Attenzione: hai DESCRITTO un’azione senza eseguirla. Sul disegno non è cambiato niente.',
                  'Descrivere non fa nulla: quello che dici di aver fatto va fatto chiamando lo strumento.',
                ]
              : []),
            ...(reply.content.includes('?') || /mi serv|mi occorr|puoi indicar/i.test(reply.content)
              ? [
                  'Qui non c’è nessuno che possa risponderti: sei tu a decidere.',
                  'Scegli il valore più ragionevole per quello che ti manca e vai avanti.',
                  'Per un dato che non puoi dedurre usa `{{secrets.NOME}}` o un valore di esempio.',
                ]
              : []),
            // Il richiamo deve indicare il passo SUCCESSIVO, non ripetere
            // quello appena fatto. Dire «comincia da analyze_goal» a chi lo
            // ha appena chiamato lo manda a richiamarlo: obbedisce, e ci si
            // avvita in due mosse. Succedeva a ogni tentativo.
            prossimoPasso(steps, montatiFinora),
          ].join('\n'),
        },
      );
      continue;
    }

    // Ha chiamato: qualunque cosa avesse detto prima, sta lavorando.
    aVuoto = 0;

    history.push({
      role: 'assistant',
      content: reply.content,
      toolCalls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    });

    let rejected = false;
    for (const call of reply.toolCalls) {
      const outcome = executeWorkflowTool(ctx, call.name, call.arguments);
      const record: AgentStep = {
        step: steps.length + 1,
        tool: call.name,
        args: call.arguments,
        result: outcome.data,
      };
      steps.push(record);
      req.onStep?.(record);

      history.push({
        role: 'tool',
        content: JSON.stringify(outcome.data),
        toolCallId: call.id,
        name: call.name,
      });

      if (!outcome.done) continue;

      const assessment = assess(builder, req.databases);
      if (assessment.blocking.length === 0) return finishFrom(builder, steps, req.databases);

      // Ha dichiarato finito qualcosa che non lo è. Invece di bocciarlo
      // subito gli si dice cosa manca: quasi sempre il giro dopo lo
      // sistema, e un rifiuto secco butterebbe via tutto il lavoro fatto.
      if (pushbacks >= MAX_PUSHBACKS) {
        return failFrom(
          builder,
          steps,
          `Il workflow ha ancora ${assessment.blocking.length} problemi dopo ${String(MAX_PUSHBACKS)} richiami:\n${assessment.blocking.join('\n')}`,
          req.databases,
        );
      }
      pushbacks++;
      history.push({
        role: 'user',
        content: [
          'Non posso accettare il workflow: questi problemi lo renderebbero non funzionante.',
          ...assessment.blocking,
          '',
          'Correggili con set_config / connect / delete_node, poi richiama validate_workflow e infine finish.',
        ].join('\n'),
      });
      rejected = true;
      break;
    }
    if (rejected) continue;
  }

  // «Non ha concluso entro 40 passi» da solo manda a cercare il problema
  // nella richiesta dell'utente, che quasi mai c'entra. Quello che serve è
  // sapere *cosa* ha fatto in quei passi: se ha costruito e non è riuscito a
  // chiudere, o se non ha costruito niente.
  const montati = builder.snapshot().nodes.length;
  const dettaglio =
    montati === 0
      ? 'Non è riuscito a mettere nemmeno un nodo: gli strumenti hanno risposto con un errore a ogni tentativo. Apri i passi qui sotto per vedere quale.'
      : `Ha montato ${String(montati)} nodi ma non è riuscito a chiudere: guarda i passi qui sotto per vedere dove si è impuntato.`;

  return failFrom(
    builder,
    steps,
    `L'agente non ha concluso entro ${String(MAX_STEPS)} passi. ${dettaglio}`,
    req.databases,
  );
}

interface Assessment {
  violations: Violation[];
  qualityIssues: QualityIssue[];
  /** I problemi che impediscono di consegnare il workflow, già in parole. */
  blocking: string[];
}

/**
 * Il giudizio completo: forma e sostanza insieme.
 *
 * Gli avvisi non bloccano — un `logic_switch` senza ramo di default è una
 * scelta discutibile, non un errore — ma i problemi critici sì: quelli a
 * runtime si romperebbero di sicuro.
 */
function assess(builder: WorkflowBuilder, databases?: readonly QualityDatabase[]): Assessment {
  const violations = builder.validate();
  const quality = builder.quality(databases);
  const critical = quality.issues.filter((i) => i.severity === 'critical');
  return {
    violations,
    qualityIssues: quality.issues,
    blocking: [...violations.map((v) => v.message), ...describeIssues(critical)],
  };
}

function failFrom(
  builder: WorkflowBuilder,
  steps: AgentStep[],
  reason: string,
  databases?: readonly QualityDatabase[],
): AgentFailure {
  const assessment = assess(builder, databases);
  return {
    ok: false,
    steps,
    reason,
    violations: assessment.violations,
    qualityIssues: assessment.qualityIssues,
    partial: builder.snapshot(),
  };
}

/** Chiusura: si consegna solo un workflow che sta in piedi. */
function finishFrom(
  builder: WorkflowBuilder,
  steps: AgentStep[],
  databases?: readonly QualityDatabase[],
): AgentResult {
  const assessment = assess(builder, databases);
  const snapshot = builder.snapshot();

  if (assessment.blocking.length > 0) {
    return failFrom(
      builder,
      steps,
      `Il workflow ha ${assessment.blocking.length} problemi non risolti:\n${assessment.blocking.join('\n')}`,
      databases,
    );
  }

  // Ciò che resta sono avvisi e scelte da fare a mano: l'utente li vede, ma
  // il workflow funziona.
  const warnings = assessment.qualityIssues
    .filter((i) => i.severity !== 'info')
    .map((i) => i.message);

  return {
    ok: true,
    workflow: {
      name: snapshot.name,
      ...(snapshot.description ? { description: snapshot.description } : {}),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      executionTarget: 'local',
    },
    steps,
    remainingIssues: [
      ...builder.orphanNodes().map((id) => `Il nodo "${id}" non è collegato a nulla.`),
      ...warnings,
    ],
  };
}
