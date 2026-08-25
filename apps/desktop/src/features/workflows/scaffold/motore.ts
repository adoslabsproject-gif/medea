/**
 * Far costruire il workflow al motore, che è dove vive la pipeline vera.
 *
 * Il desktop ha una sua generazione, in `run.ts` e `agent.ts`, e per un po' è
 * stata l'unica: parla direttamente col provider e si arrangia. È scritta
 * bene, ma è diciassette moduli contro i quarantanove del motore, e le mancano
 * i pezzi che fanno la differenza fra un workflow plausibile e uno che parte —
 * `semantic-autoconfig`, che riempie da solo i campi deterministici, la
 * grammatica vincolata costruita sul tipo di ciascun nodo, la cache dei
 * template, il giro di riparazione guidato dal validatore del catalogo.
 *
 * Quella pipeline è già qui, gira in `apps/engine`, ed è la stessa di
 * FlowForge. Non veniva interpellata da nessuno: il wizard aveva accanto il
 * motore acceso e generava per conto suo. Adesso lo chiama.
 *
 * Resta il ripiego: se il motore non c'è — non è ancora partito, o il provider
 * scelto non è esprimibile nella sua richiesta — si torna alla strada locale.
 * Meglio la generazione più povera che nessuna generazione.
 *
 * @module features/workflows/scaffold/motore
 */

import { activeProvider, providerConnection } from '../../ai/connection';
import { forgetSession, session } from '../runtime/client';
import { createSseReader, parseData } from '../runtime/sse';
import type { Workflow } from '../types';

import type { AgentStep } from './agent';
import { providerPerMotore, tabelleDalMotore, workflowDalMotore } from './motore-mappa';
import type { ScaffoldOutput } from './schema';

/** Quanto si insiste a chiedere il risultato quando lo stream cade a metà. */
const TENTATIVI_RECUPERO = 60;
const ATTESA_RECUPERO_MS = 2_000;

export interface EsitoMotoreOk {
  ok: true;
  workflow: Workflow;
  /** Cosa racconta il motore di quello che ha fatto. */
  note: string[];
  modello: string;
  tabelleDaCreare: ScaffoldOutput['tablesToCreate'];
}

export interface EsitoMotoreNo {
  ok: false;
  motivo: string;
  /**
   * Il motore non ha GIUDICATO: non è riuscito ad avere una risposta.
   *
   * È la distinzione che decide cosa succede dopo, e va letta con attenzione
   * perché le due cose si assomigliano solo da lontano.
   *
   * Un motore che ha lavorato e ha **rifiutato il risultato** — «la tabella
   * non esiste», «questo nodo è orfano» — ha espresso un verdetto: rifarlo con
   * meno mezzi darebbe qualcosa di peggiore, e consegnarlo come se fosse la
   * stessa cosa sarebbe una bugia. Lì non si ripiega.
   *
   * Un motore che **non ha ottenuto una risposta** è un altro paio di maniche:
   * spento, un provider irraggiungibile, o — visto il 2026-08-06 — un modello
   * che si rifiuta di completare la generazione per una sua protezione
   * interna. Lì non c'è nessun giudizio da rispettare, e fermarsi significa
   * tenere spente due strade che funzionerebbero. Prima ci si fermava lo
   * stesso, e il wizard falliva con due alternative intatte in tasca.
   */
  ripiegabile: boolean;
}

export type EsitoMotore = EsitoMotoreOk | EsitoMotoreNo;

/**
 * Il motore ha giudicato il workflow, o non è riuscito ad averne uno?
 *
 * Solo i verdetti fermano la cascata. Tutto il resto — un modello che non
 * risponde, che si rifiuta, un provider che cade — lascia le altre strade
 * libere di provarci.
 */
export function eUnVerdetto(motivo: string): boolean {
  return (
    motivo.startsWith('Workflow rejected — quality gate') ||
    motivo.startsWith('Workflow generato con')
  );
}

export interface RichiestaMotore {
  goal: string;
  onStep?: (step: AgentStep) => void;
  /**
   * Quanti token sono stati consumati, man mano.
   *
   * Il motore lo dice — emette `token_usage` — e nessuno lo ascoltava: il
   * contatore era collegato alle sole strade LOCALI. Finché il motore era
   * l'ultima spiaggia non si notava; da quando è la prima, e quasi sempre
   * l'unica a girare, il numero è semplicemente sparito dal wizard.
   */
  onToken?: (usati: { input: number; output: number }) => void;
  signal?: AbortSignal;
}

/** Il risultato come lo manda il motore, prima di essere guardato. */
interface RisultatoGrezzo {
  workflow?: unknown;
  notes?: unknown;
  modelUsed?: unknown;
  tablesToCreate?: unknown;
}

function leggiRisultato(grezzo: unknown): EsitoMotore {
  const risultato = (grezzo ?? {}) as RisultatoGrezzo;
  const workflow = workflowDalMotore(risultato.workflow);
  if (!workflow) {
    return {
      ok: false,
      motivo: 'Il motore ha risposto senza un workflow leggibile.',
      ripiegabile: true,
    };
  }
  return {
    ok: true,
    workflow,
    note: Array.isArray(risultato.notes)
      ? risultato.notes.filter((n): n is string => typeof n === 'string')
      : [],
    modello: typeof risultato.modelUsed === 'string' ? risultato.modelUsed : 'sconosciuto',
    tabelleDaCreare: tabelleDalMotore(risultato.tablesToCreate),
  };
}

/**
 * I passi del motore nella forma che il pannello sa mostrare.
 *
 * Il motore racconta il proprio lavoro con gli stessi nomi di strumento che il
 * wizard già traduce in italiano — `singleshot_generate` è lo stesso lì e qui —
 * quindi non serve un secondo vocabolario: basta dargli la forma giusta.
 */
function passoDaEvento(
  numero: number,
  evento: string,
  dati: Record<string, unknown>,
): AgentStep | null {
  if (evento === 'tool_call') {
    const tool = typeof dati.tool === 'string' ? dati.tool : evento;
    const args = (dati.args ?? {}) as Record<string, unknown>;
    return { step: numero, tool, args, result: { stato: 'in corso' } };
  }
  if (evento === 'tool_result') {
    const tool = typeof dati.tool === 'string' ? dati.tool : evento;
    const ok = dati.ok !== false;
    return {
      step: numero,
      tool,
      args: {},
      result: ok ? { ok: true } : { ok: false, error: dati.error ?? 'non riuscito' },
    };
  }
  return null;
}

/**
 * Chiede il risultato finché il motore non lo dà.
 *
 * Serve quando lo stream cade a metà — succede, ed è il motivo per cui il
 * motore persiste il lavoro sotto un identificativo invece di affidarlo alla
 * connessione. Senza questo, una generazione riuscita in tre minuti si
 * perderebbe per una connessione caduta al secondo minuto e mezzo.
 */
async function recuperaRisultato(jobId: string, signal?: AbortSignal): Promise<EsitoMotore> {
  const s = await session();
  for (let giro = 0; giro < TENTATIVI_RECUPERO; giro++) {
    if (signal?.aborted) return { ok: false, motivo: 'Interrotto.', ripiegabile: false };
    const risposta = await fetch(`${s.baseUrl}/api/v1/workflows/ai-scaffold/result/${jobId}`, {
      headers: { authorization: `Bearer ${s.token}` },
      ...(signal ? { signal } : {}),
    });
    if (risposta.status === 404) {
      return { ok: false, motivo: 'Il motore non ricorda questa generazione.', ripiegabile: true };
    }
    const corpo = (await risposta.json()) as { status?: string; result?: unknown; error?: unknown };
    if (corpo.status === 'done') return leggiRisultato(corpo.result);
    if (corpo.status === 'error') {
      const motivo =
        typeof corpo.error === 'string' ? corpo.error : 'Il motore ha rifiutato il lavoro.';
      return { ok: false, motivo, ripiegabile: !eUnVerdetto(motivo) };
    }
    await new Promise<void>((risolvi) => setTimeout(risolvi, ATTESA_RECUPERO_MS));
  }
  return { ok: false, motivo: 'Il motore non ha finito in tempo.', ripiegabile: false };
}

export async function generaColMotore(req: RichiestaMotore): Promise<EsitoMotore> {
  const provider = activeProvider();
  const nomeMotore = providerPerMotore(provider);
  if (!nomeMotore) {
    return {
      ok: false,
      motivo: `Il motore non sa parlare con «${provider}».`,
      ripiegabile: true,
    };
  }

  let s: Awaited<ReturnType<typeof session>>;
  let apiKey: string | undefined;
  // L'indirizzo va mandato insieme alla chiave, non tenuto qui.
  //
  // Per i provider self-hosted — Liara prima di tutti — l'host lo conosce solo
  // il desktop: sta nelle impostazioni dell'utente, non nel registro dei
  // provider del motore. Mandando provider e chiave ma non indirizzo, il
  // motore usava il default del registro e la richiesta finiva su un host che
  // per un motore locale non esiste. L'utente leggeva «LLM single-shot
  // fallito: fetch failed», che è vero e non dice niente.
  let baseUrl: string | undefined;
  try {
    [s, { apiKey, baseUrl }] = await Promise.all([session(), providerConnection(provider)]);
  } catch (e) {
    return { ok: false, motivo: `Il motore non è raggiungibile: ${String(e)}`, ripiegabile: true };
  }

  const corpo = JSON.stringify({
    goal: req.goal,
    provider: nomeMotore,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });

  const chiedi = (sessione: { baseUrl: string; token: string }): Promise<Response> =>
    fetch(`${sessione.baseUrl}/api/v1/workflows/ai-scaffold/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessione.token}`,
        accept: 'text/event-stream',
      },
      body: corpo,
      ...(req.signal ? { signal: req.signal } : {}),
    });

  let risposta: Response;
  try {
    risposta = await chiedi(s);
  } catch {
    // La sessione è tenuta in memoria e viene buttata solo su un 401. Un
    // motore *morto* però non risponde 401: non risponde affatto, e la
    // sessione in cache continua a indicare una porta che non ascolta più.
    // Chi chiede resta convinto che il motore non ci sia mai stato e ripiega
    // sulla generazione più povera — in silenzio, per sempre, finché non si
    // riavvia l'app.
    //
    // Riprendersela è ciò che lo fa ripartire: il comando che la rilascia
    // riavvia il processo se serve. Una volta sola: se non risponde nemmeno
    // così, il problema non è la sessione.
    forgetSession();
    try {
      risposta = await chiedi(await session());
    } catch (e) {
      return { ok: false, motivo: `Il motore non ha risposto: ${String(e)}`, ripiegabile: true };
    }
  }

  if (risposta.status === 401) {
    forgetSession();
    return { ok: false, motivo: 'La sessione col motore è scaduta.', ripiegabile: true };
  }
  if (!risposta.ok || !risposta.body) {
    return {
      ok: false,
      motivo: `Il motore ha risposto ${String(risposta.status)}.`,
      ripiegabile: true,
    };
  }

  const lettore = risposta.body.getReader();
  const decodificatore = new TextDecoder();
  const leggi = createSseReader();
  let jobId: string | null = null;
  let numero = 0;

  try {
    for (;;) {
      const { done, value } = await lettore.read();
      if (done) break;
      for (const messaggio of leggi(decodificatore.decode(value, { stream: true }))) {
        if (messaggio.event === 'ping') continue;
        const dati = (parseData(messaggio) ?? {}) as Record<string, unknown>;

        if (messaggio.event === 'job') {
          if (typeof dati.jobId === 'string') jobId = dati.jobId;
          continue;
        }
        if (messaggio.event === 'done') return leggiRisultato(dati.result);
        if (messaggio.event === 'error') {
          const motivo =
            typeof dati.error === 'string' ? dati.error : 'Il motore ha rifiutato il lavoro.';
          return { ok: false, motivo, ripiegabile: !eUnVerdetto(motivo) };
        }

        if (messaggio.event === 'token_usage') {
          const t = dati.tokens as { input?: unknown; output?: unknown } | undefined;
          if (typeof t?.input === 'number' && typeof t.output === 'number') {
            req.onToken?.({ input: t.input, output: t.output });
          }
          continue;
        }

        const passo = passoDaEvento(numero + 1, messaggio.event, dati);
        if (passo) {
          numero++;
          req.onStep?.(passo);
        }
      }
    }
  } catch (e) {
    // Lo stream è caduto: il lavoro però è del motore, non della connessione.
    if (jobId) return recuperaRisultato(jobId, req.signal);
    return { ok: false, motivo: `Lo stream è caduto: ${String(e)}`, ripiegabile: true };
  }

  // Finito senza `done`: stessa storia, stessa risposta.
  if (jobId) return recuperaRisultato(jobId, req.signal);
  return { ok: false, motivo: 'Il motore ha chiuso senza un risultato.', ripiegabile: true };
}
