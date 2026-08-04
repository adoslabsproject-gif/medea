/**
 * `runScaffold` promette due soli esiti: workflow valido o fallimento
 * spiegato. Questi test lo mettono davanti a provider che mentono, cadono,
 * rifiutano o producono forme patologiche — e verificano che la promessa
 * regga sempre: mai un salvataggio rotto, mai un'eccezione non gestita.
 */

import { describe, expect, it } from 'vitest';

import { at, CATALOG, fakeLlm, flakyLlm, makeValid } from './fixtures';
import { SCAFFOLD_SYSTEM_PROMPT, SCAFFOLD_SYSTEM_PROMPT_TUNED } from './prompt';
import { runScaffold } from './run';

const VALID_JSON = () => JSON.stringify(makeValid());

describe('percorso felice', () => {
  it('restituisce un workflow valido al primo colpo, pronto per il canvas', async () => {
    const res = await runScaffold({
      goal: 'controllo giornaliero',
      catalog: CATALOG,
      llm: fakeLlm([VALID_JSON()]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempts).toBe(1);
      expect(res.workflow.nodes).toHaveLength(3);
      expect(res.workflow.executionTarget).toBe('local');
      expect(res.workflow.nodes.every((n) => typeof n.x === 'number')).toBe(true);
      expect(res.workflow.edges).toEqual([
        { from: 'cron', to: 'fetch' },
        { from: 'fetch', to: 'notify' },
      ]);
    }
  });

  it('recupera un output sporco senza scomodare un secondo giro', async () => {
    const dirty = makeValid();
    at(dirty.nodes, 1).config.method = 'get';
    at(dirty.nodes, 1).defId = 'action_http_stripe';
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm(['```json\n' + JSON.stringify(dirty) + '\n```']),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempts).toBe(1);
      expect(res.repairs.length).toBeGreaterThan(0);
    }
  });
});

describe('ciclo di correzione', () => {
  it('riprova passando al modello gli errori veri del giro prima', async () => {
    const broken = makeValid();
    delete at(broken.nodes, 2).config.subject;
    const llm = fakeLlm([JSON.stringify(broken), VALID_JSON()]);
    const res = await runScaffold({ goal: 'x', catalog: CATALOG, llm });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(2);
    expect(llm.calls[1]?.user).toContain('TENTATIVO PRECEDENTE');
    expect(llm.calls[1]?.user).toContain('subject');
  });

  it('fallisce dichiarandolo invece di salvare un workflow rotto', async () => {
    const broken = makeValid();
    at(broken.nodes, 1).defId = 'nodo_che_non_esiste';
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(broken)]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(3);
      expect(res.violations[0]?.kind).toBe('unknown_def');
      expect(res.reason).toContain('3 tentativi');
    }
  });

  it('scandisce le fasi in ordine per la UI', async () => {
    const phases: string[] = [];
    await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([VALID_JSON()]),
      onProgress: (phase, attempt) => phases.push(`${phase}:${attempt}`),
    });
    expect(phases).toEqual(['generazione:1', 'riparazione:1', 'validazione:1', 'qualità:1']);
  });
});

describe('provider ostili o rotti', () => {
  it('un rifiuto in prosa produce un fallimento spiegato, non un crash', async () => {
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm(['Mi dispiace, non posso.']),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('JSON');
  });

  it('sopravvive a un provider che cade una volta e riprova', async () => {
    const llm = flakyLlm(1, [VALID_JSON()]);
    const res = await runScaffold({ goal: 'x', catalog: CATALOG, llm });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(2);
    expect(llm.calls[1]?.user).toContain('Il provider non ha risposto');
  });

  it('un provider sempre giù esaurisce i tentativi con un motivo', async () => {
    const res = await runScaffold({ goal: 'x', catalog: CATALOG, llm: flakyLlm(99, []) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(3);
      expect(res.reason).toContain('provider');
    }
  });

  it('un nodo senza config viene respinto alla porta: mai un TypeError', async () => {
    const malformed = JSON.stringify({
      name: 'x',
      reasoning: 'a'.repeat(60),
      nodes: [{ id: 'a', defId: 'trigger_cron' }],
      edges: [],
    });
    const res = await runScaffold({ goal: 'x', catalog: CATALOG, llm: fakeLlm([malformed]) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('campi obbligatori');
  });

  it('un array JSON in radice è un fallimento pulito', async () => {
    const res = await runScaffold({ goal: 'x', catalog: CATALOG, llm: fakeLlm(['[1,2,3]']) });
    expect(res.ok).toBe(false);
  });
});

describe('tabelle richieste dal workflow', () => {
  it('una tabella valida attraversa il ciclo già normalizzata', async () => {
    const out = makeValid();
    out.tablesToCreate = [{ name: 'Followups', columns: [{ name: 'id', type: 'TEXT' }] }];
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(out)]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tablesToCreate).toEqual([
        { name: 'followups', columns: [{ name: 'id', type: 'text' }] },
      ]);
    }
  });

  it('un nome tabella ostile non arriva MAI al chiamante (bug bounty)', async () => {
    const out = makeValid();
    out.tablesToCreate = [
      { name: 'followups; DROP TABLE messages--', columns: [{ name: 'id', type: 'text' }] },
    ];
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(out)]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.some((v) => v.kind === 'invalid_table')).toBe(true);
  });

  it('una tabella che ombreggia il DB di Medea viene rifiutata', async () => {
    const out = makeValid();
    out.tablesToCreate = [{ name: 'messages', columns: [{ name: 'id', type: 'text' }] }];
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(out)]),
    });
    expect(res.ok).toBe(false);
  });
});

describe('contratto col provider', () => {
  it('sceglie il prompt compatto per i modelli tuned, quello completo altrimenti', async () => {
    const tuned = fakeLlm([VALID_JSON()], { isTuned: true });
    await runScaffold({ goal: 'x', catalog: CATALOG, llm: tuned });
    expect(tuned.calls[0]?.system).toBe(SCAFFOLD_SYSTEM_PROMPT_TUNED);

    const generic = fakeLlm([VALID_JSON()]);
    await runScaffold({ goal: 'x', catalog: CATALOG, llm: generic });
    expect(generic.calls[0]?.system).toBe(SCAFFOLD_SYSTEM_PROMPT);
  });

  it('incolla lo schema nel prompt solo se il provider non sa vincolarsi', async () => {
    const native = fakeLlm([VALID_JSON()], { supportsStructuredOutput: true });
    await runScaffold({ goal: 'x', catalog: CATALOG, llm: native });
    expect(native.calls[0]?.user).not.toContain("SCHEMA JSON DELL'OUTPUT");
    // Non più lo schema statico: quello che viaggia porta dentro i defId
    // ammessi, che sono esattamente i nodi mostrati. Vincolare la forma senza
    // vincolare i nomi lasciava al modello l'unica libertà che gli faceva
    // sbagliare — inventare un nodo che non esiste.
    const schemaInviato = native.calls[0]?.schema as {
      properties: { nodes: { items: { properties: { defId: { enum?: string[] } } } } };
    };
    expect(schemaInviato.properties.nodes.items.properties.defId.enum).toEqual(
      CATALOG.map((d) => d.defId),
    );

    const legacy = fakeLlm([VALID_JSON()]);
    await runScaffold({ goal: 'x', catalog: CATALOG, llm: legacy });
    expect(legacy.calls[0]?.user).toContain("SCHEMA JSON DELL'OUTPUT");
  });
});
