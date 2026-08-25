/**
 * Il contratto col motore, e soprattutto quando è lecito ripiegare.
 *
 * `ripiegabile` è la decisione che porta il peso: dice se, fallito il motore,
 * si può rifare lo stesso lavoro con la generazione locale — che ha meno mezzi
 * — oppure se bisogna fermarsi e dirlo. Sbagliarla in un verso perde
 * generazioni che sarebbero riuscite; sbagliarla nell'altro consegna in
 * silenzio un risultato peggiore facendolo passare per lo stesso.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentStep } from './agent';

const { activeProvider, providerConnection, session, forgetSession } = vi.hoisted(() => ({
  activeProvider: vi.fn(() => 'liara'),
  providerConnection: vi.fn(() => Promise.resolve({ apiKey: 'chiave' })),
  session: vi.fn(() => Promise.resolve({ baseUrl: 'http://127.0.0.1:1', token: 'tok' })),
  forgetSession: vi.fn(),
}));

vi.mock('../../ai/connection', () => ({ activeProvider, providerConnection }));
vi.mock('../runtime/client', () => ({ session, forgetSession }));

const { generaColMotore } = await import('./motore');

const WORKFLOW = {
  name: 'Archivia',
  nodes: [{ id: 'a', defId: 'trigger_imap', x: 0, y: 0, config: {} }],
  edges: [],
};

/** Una risposta SSE finta, costruita dagli eventi che si vogliono mandare. */
function rispostaSse(eventi: { event: string; data: unknown }[], cade = false): Response {
  const testo = eventi
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  // A pezzi, non tutto in `start`: un errore sollevato nello stesso giro
  // dell'enqueue arriva al lettore *prima* dei dati, e il test misurerebbe
  // uno stream caduto a vuoto invece di uno caduto dopo aver dato il jobId —
  // che è esattamente il caso che qui interessa.
  let inviato = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!inviato) {
        inviato = true;
        if (testo !== '') {
          controller.enqueue(new TextEncoder().encode(testo));
          return;
        }
      }
      if (cade) controller.error(new Error('connessione caduta'));
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  activeProvider.mockReturnValue('liara');
});

describe('generaColMotore — quando non si parte nemmeno', () => {
  it('ripiega senza toccare la rete se il provider non è esprimibile', async () => {
    activeProvider.mockReturnValue('custom');
    const fetchFinta = vi.fn();
    vi.stubGlobal('fetch', fetchFinta);

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.ripiegabile).toBe(true);
    expect(fetchFinta).not.toHaveBeenCalled();
  });

  it('ripiega se il motore non è raggiungibile', async () => {
    session.mockRejectedValueOnce(new Error('runtime spento'));

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) {
      expect(esito.ripiegabile).toBe(true);
      expect(esito.motivo).toContain('runtime spento');
    }
  });
});

describe('generaColMotore — quando il motore risponde', () => {
  it('consegna il workflow e racconta i passi', async () => {
    const passi: AgentStep[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          rispostaSse([
            { event: 'job', data: { jobId: 'j1' } },
            { event: 'tool_call', data: { tool: 'singleshot_generate', args: { goal: 'x' } } },
            { event: 'tool_result', data: { tool: 'singleshot_generate', ok: true } },
            {
              event: 'done',
              data: { result: { workflow: WORKFLOW, notes: ['fatto'], modelUsed: 'nha-v1' } },
            },
          ]),
        ),
      ),
    );

    const esito = await generaColMotore({
      goal: 'archivia le newsletter',
      onStep: (p) => passi.push(p),
    });

    expect(esito.ok).toBe(true);
    if (esito.ok) {
      expect(esito.workflow.nodes[0]?.defId).toBe('trigger_imap');
      expect(esito.note).toEqual(['fatto']);
      expect(esito.modello).toBe('nha-v1');
    }
    expect(passi.map((p) => p.tool)).toEqual(['singleshot_generate', 'singleshot_generate']);
  });

  /**
   * Il motore ha lavorato e ha detto di no: **non** si ripiega.
   *
   * Rifare lo stesso lavoro con la generazione locale, che ha meno mezzi, non
   * può che dare qualcosa di peggiore di ciò che il motore ha già giudicato
   * insufficiente — e consegnarlo senza dirlo lo farebbe passare per la stessa
   * cosa.
   */
  /**
   * Un VERDETTO ferma la cascata: il motore ha lavorato e ha giudicato, e
   * rifarlo con meno mezzi darebbe qualcosa di peggiore.
   *
   * Il messaggio è quello VERO del motore, non una parafrasi: prima qui c'era
   * «quality gate: 3 problemi», che sul filo non passa mai — il test
   * descriveva un formato che non esiste, e avrebbe continuato a passare anche
   * se la distinzione si fosse rotta.
   */
  it('non ripiega quando il motore ha giudicato il workflow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          rispostaSse([
            { event: 'job', data: { jobId: 'j1' } },
            {
              event: 'error',
              data: { error: 'Workflow rejected — quality gate ha trovato 2 bug critici: •…' },
            },
          ]),
        ),
      ),
    );

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) {
      expect(esito.ripiegabile).toBe(false);
      expect(esito.motivo).toContain('quality gate');
    }
  });

  /**
   * Il caso del 2026-08-06: il modello si interrompe a metà JSON dicendo che
   * non può condividere le proprie istruzioni. Non ha giudicato niente — è una
   * sua protezione interna — e fermarsi lì significava tenere spente due
   * strade che avrebbero potuto funzionare.
   */
  it('ripiega quando è il MODELLO a rifiutarsi, non il motore a giudicare', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          rispostaSse([
            { event: 'job', data: { jobId: 'j1' } },
            {
              event: 'error',
              data: { error: 'Il modello si è rifiutato di completare la risposta: …' },
            },
          ]),
        ),
      ),
    );

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.ripiegabile).toBe(true);
  });

  it('ripiega se il motore risponde con un workflow illeggibile', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(rispostaSse([{ event: 'done', data: { result: { workflow: null } } }])),
      ),
    );

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.ripiegabile).toBe(true);
  });
});

describe('generaColMotore — quando lo stream cade', () => {
  /**
   * Il lavoro è del motore, non della connessione.
   *
   * Una generazione può durare minuti, e in quei minuti la connessione cade.
   * Il motore per questo persiste il risultato sotto un identificativo:
   * senza andarselo a riprendere, un lavoro riuscito al terzo minuto si
   * perderebbe per una caduta al secondo e mezzo, e l'utente lo rifarebbe da
   * capo pagandolo due volte.
   */
  it('va a riprendersi il risultato con il jobId', async () => {
    const fetchFinta = vi
      .fn()
      .mockResolvedValueOnce(rispostaSse([{ event: 'job', data: { jobId: 'j1' } }], true))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'done', result: { workflow: WORKFLOW } }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchFinta);

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(true);
    expect(fetchFinta.mock.calls[1]?.[0]).toContain('/ai-scaffold/result/j1');
  });

  it('senza jobId non ha cosa riprendere, e ripiega', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(rispostaSse([], true))),
    );

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.ripiegabile).toBe(true);
  });

  it('se il motore non ricorda la generazione, ripiega', async () => {
    const fetchFinta = vi
      .fn()
      .mockResolvedValueOnce(rispostaSse([{ event: 'job', data: { jobId: 'j1' } }], true))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'unknown' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchFinta);

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.ripiegabile).toBe(true);
  });
});

describe('generaColMotore — quando il motore è morto', () => {
  /**
   * Il caso che ha ingannato la prova del 2026-08-05.
   *
   * La sessione col motore vive in memoria e viene buttata solo su un 401. Un
   * processo morto non risponde 401 — non risponde — quindi la sessione in
   * cache continua a indicare una porta che non ascolta più, e ogni tentativo
   * successivo fallisce allo stesso modo. Il wizard ripiegava sulla
   * generazione più povera in silenzio, per sempre, senza che nulla dicesse
   * che il motore c'era e bastava richiamarlo.
   */
  it('si riprende la sessione e riprova una volta: è ciò che lo fa ripartire', async () => {
    const fetchFinta = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        rispostaSse([{ event: 'done', data: { result: { workflow: WORKFLOW } } }]),
      );
    vi.stubGlobal('fetch', fetchFinta);

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(true);
    expect(forgetSession).toHaveBeenCalled();
    expect(fetchFinta).toHaveBeenCalledTimes(2);
  });

  it('se non risponde neanche alla seconda, ripiega', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );

    const esito = await generaColMotore({ goal: 'archivia le newsletter' });

    expect(esito.ok).toBe(false);
    if (!esito.ok) expect(esito.ripiegabile).toBe(true);
  });
});

/**
 * Il contatore dei token sparito dal wizard.
 *
 * Il motore lo dice — emette `token_usage` — e nessuno lo ascoltava: il
 * contatore era collegato alle sole strade LOCALI. Finché il motore era
 * l'ultima spiaggia non si notava; da quando è la prima, e quasi sempre
 * l'unica a girare, il numero è semplicemente sparito.
 */
describe('generaColMotore — quanti token sono costati', () => {
  it('riporta il consumo che il motore dichiara', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          rispostaSse([
            { event: 'job', data: { jobId: 'j1' } },
            {
              event: 'token_usage',
              data: { type: 'token_usage', tokens: { input: 8535, output: 429 } },
            },
            { event: 'done', data: { result: { workflow: WORKFLOW } } },
          ]),
        ),
      ),
    );

    const visti: { input: number; output: number }[] = [];
    const esito = await generaColMotore({
      goal: 'archivia le newsletter',
      onToken: (t) => visti.push(t),
    });

    expect(esito.ok).toBe(true);
    expect(visti).toEqual([{ input: 8535, output: 429 }]);
  });

  /** Un evento malformato non deve far cadere la generazione. */
  it('ignora un consumo senza numeri invece di rompersi', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          rispostaSse([
            { event: 'job', data: { jobId: 'j1' } },
            { event: 'token_usage', data: { type: 'token_usage', tokens: { input: 'molti' } } },
            { event: 'done', data: { result: { workflow: WORKFLOW } } },
          ]),
        ),
      ),
    );

    const visti: unknown[] = [];
    const esito = await generaColMotore({
      goal: 'archivia le newsletter',
      onToken: (t) => visti.push(t),
    });

    expect(esito.ok).toBe(true);
    expect(visti).toEqual([]);
  });
});
