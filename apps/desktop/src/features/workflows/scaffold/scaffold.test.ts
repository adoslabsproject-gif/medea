/**
 * La barra dello scaffold, in forma eseguibile.
 *
 * Il criterio è uno: **un workflow non valido non può passare**. Questi test
 * simulano i modi in cui i modelli sbagliano davvero — JSON dentro un blocco
 * markdown, defId inventati per specializzazione, enum con le maiuscole
 * sbagliate, campi obbligatori dimenticati, collegamenti verso il nulla — e
 * verificano che ognuno venga corretto o rifiutato con un motivo leggibile.
 */

import { describe, expect, it } from 'vitest';

import type { NodeDef } from '../types';

import { indexByDefId } from './catalog';
import { formatCatalogEntry } from './catalog';
import { parseScaffoldJson } from './parse';
import { repairScaffold } from './repair';
import { runScaffold, type ScaffoldLlm } from './run';
import type { ScaffoldOutput } from './schema';
import { validateScaffold } from './validate';

const CATALOG: NodeDef[] = [
  {
    defId: 'trigger_cron',
    type: 'trigger',
    label: 'Pianificazione',
    configFields: [{ key: 'cron', type: 'cron-builder', required: true }],
  },
  {
    defId: 'action_http',
    type: 'action',
    label: 'Chiamata HTTP',
    configFields: [
      { key: 'url', type: 'string', required: true },
      {
        key: 'method',
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'DELETE'],
        defaultValue: 'GET',
      },
    ],
  },
  {
    defId: 'action_send_email',
    type: 'action',
    label: 'Invia email',
    configFields: [
      { key: 'to', type: 'string', required: true },
      { key: 'subject', type: 'string', required: true },
      { key: 'body', type: 'rich-text' },
    ],
  },
  {
    defId: 'logic_if',
    type: 'logic',
    label: 'Condizione',
    configFields: [{ key: 'conditionRules', type: 'condition-rules', required: true }],
    outputPorts: ['true', 'false'],
  },
];

const INDEX = indexByDefId(CATALOG);

/** Un modello finto che risponde con quello che gli si dice. */
function fakeLlm(responses: string[], opts: Partial<ScaffoldLlm> = {}): ScaffoldLlm {
  let i = 0;
  return {
    supportsStructuredOutput: false,
    ...opts,
    complete: () => Promise.resolve(responses[Math.min(i++, responses.length - 1)] ?? ''),
  };
}

const VALID: ScaffoldOutput = {
  name: 'Controllo giornaliero',
  reasoning:
    'Il trigger a orario avvia il flusso, la chiamata HTTP recupera i dati e infine parte una email di riepilogo al referente.',
  nodes: [
    { id: 'cron', defId: 'trigger_cron', config: { cron: '0 9 * * *' } },
    {
      id: 'fetch',
      defId: 'action_http',
      config: { url: 'https://esempio.test/dati', method: 'GET' },
    },
    {
      id: 'notify',
      defId: 'action_send_email',
      config: { to: 'team@esempio.test', subject: 'Riepilogo' },
    },
  ],
  edges: [
    { from: 'cron', to: 'fetch' },
    { from: 'fetch', to: 'notify' },
  ],
};

describe('formato del catalogo', () => {
  it('mantiene la forma compatta attesa dal modello', () => {
    expect(formatCatalogEntry(CATALOG[1]!)).toBe(
      'action_http (action): url:string(REQUIRED), method:select(enum[GET|POST|PUT|DELETE],default="GET")',
    );
  });

  it('segnala i nodi senza configurazione invece di lasciare il vuoto', () => {
    expect(formatCatalogEntry({ defId: 'x', type: 'action', label: 'X' })).toContain('(no config)');
  });
});

describe('parsing tollerante', () => {
  it('accetta JSON puro', () => {
    expect(parseScaffoldJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('accetta JSON dentro un blocco markdown', () => {
    expect(parseScaffoldJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('accetta JSON preceduto da prosa', () => {
    expect(parseScaffoldJson('Ecco il workflow:\n{"a":1}\nSpero vada bene')).toEqual({ a: 1 });
  });

  it('non si fa ingannare da una graffa dentro una stringa', () => {
    expect(parseScaffoldJson('{"t":"usa {{$node.x}} qui"}')).toEqual({ t: 'usa {{$node.x}} qui' });
  });

  it('fallisce dicendo cosa è arrivato', () => {
    expect(() => parseScaffoldJson('Non posso aiutarti con questo.')).toThrow(
      /non contiene un oggetto JSON/,
    );
  });
});

describe('validazione', () => {
  it('accetta un workflow corretto', () => {
    expect(validateScaffold(structuredClone(VALID), INDEX)).toHaveLength(0);
  });

  it('rifiuta un defId che non esiste', () => {
    const out = structuredClone(VALID);
    out.nodes[1]!.defId = 'action_inventato';
    const v = validateScaffold(out, INDEX);
    expect(v[0]?.kind).toBe('unknown_def');
  });

  it("rifiuta un valore fuori dall'enum, elencando quelli ammessi", () => {
    const out = structuredClone(VALID);
    out.nodes[1]!.config.method = 'FETCH';
    const v = validateScaffold(out, INDEX);
    expect(v[0]?.kind).toBe('invalid_enum');
    expect(v[0]?.message).toContain('GET | POST | PUT | DELETE');
  });

  it('rifiuta un campo obbligatorio mancante', () => {
    const out = structuredClone(VALID);
    delete out.nodes[2]!.config.subject;
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'missing_required')).toBe(true);
  });

  it('rifiuta un campo che non appartiene al nodo', () => {
    const out = structuredClone(VALID);
    out.nodes[1]!.config.timeoutMs = 5000;
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'unknown_config_key')).toBe(true);
  });

  it('rifiuta un collegamento verso un nodo inesistente', () => {
    const out = structuredClone(VALID);
    out.edges.push({ from: 'notify', to: 'fantasma' });
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'dangling_edge')).toBe(true);
  });

  it('rifiuta una porta inventata', () => {
    const out = structuredClone(VALID);
    out.nodes.push({ id: 'check', defId: 'logic_if', config: { conditionRules: '[]' } });
    out.edges.push({ from: 'check', to: 'notify', fromPort: 'forse' });
    const v = validateScaffold(out, INDEX);
    expect(v.some((x) => x.kind === 'invalid_port')).toBe(true);
    expect(v.find((x) => x.kind === 'invalid_port')?.message).toContain('true | false');
  });
});

describe('riparazioni deterministiche', () => {
  it('riconduce un defId specializzato a quello vero', () => {
    const out = structuredClone(VALID);
    out.nodes[1]!.defId = 'action_http_clearbit';
    repairScaffold(out, INDEX);
    expect(out.nodes[1]!.defId).toBe('action_http');
  });

  it('normalizza le maiuscole di un enum invece di bocciarlo', () => {
    const out = structuredClone(VALID);
    out.nodes[1]!.config.method = 'post';
    repairScaffold(out, INDEX);
    expect(out.nodes[1]!.config.method).toBe('POST');
    expect(validateScaffold(out, INDEX)).toHaveLength(0);
  });

  it('applica i default dichiarati', () => {
    const out = structuredClone(VALID);
    delete out.nodes[1]!.config.method;
    repairScaffold(out, INDEX);
    expect(out.nodes[1]!.config.method).toBe('GET');
  });

  it('rende univoci gli id duplicati aggiornando i collegamenti', () => {
    const out = structuredClone(VALID);
    out.nodes[2]!.id = 'fetch';
    out.edges[1] = { from: 'fetch', to: 'fetch' };
    repairScaffold(out, INDEX);
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(3);
  });

  it('rimuove i collegamenti doppi', () => {
    const out = structuredClone(VALID);
    out.edges.push({ from: 'cron', to: 'fetch' });
    repairScaffold(out, INDEX);
    expect(out.edges).toHaveLength(2);
  });

  it('assegna le posizioni mancanti', () => {
    const out = structuredClone(VALID);
    repairScaffold(out, INDEX);
    expect(out.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
  });
});

describe('il ciclo completo', () => {
  it('restituisce un workflow valido al primo colpo', async () => {
    const res = await runScaffold({
      goal: 'controllo giornaliero',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(VALID)]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attempts).toBe(1);
      expect(res.workflow.nodes).toHaveLength(3);
    }
  });

  it('recupera un output sporco senza scomodare un secondo giro', async () => {
    const dirty = structuredClone(VALID);
    dirty.nodes[1]!.config.method = 'get';
    dirty.nodes[1]!.defId = 'action_http_stripe';
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm(['```json\n' + JSON.stringify(dirty) + '\n```']),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(1);
  });

  it('riprova con gli errori in mano e ce la fa al secondo giro', async () => {
    const broken = structuredClone(VALID);
    delete broken.nodes[2]!.config.subject;
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(broken), JSON.stringify(VALID)]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(2);
  });

  it('fallisce dichiarandolo invece di salvare un workflow rotto', async () => {
    const broken = structuredClone(VALID);
    broken.nodes[1]!.defId = 'nodo_che_non_esiste';
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm([JSON.stringify(broken)]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(3);
      expect(res.violations[0]?.kind).toBe('unknown_def');
    }
  });

  it('non si blocca se il provider risponde a vuoto', async () => {
    const res = await runScaffold({
      goal: 'x',
      catalog: CATALOG,
      llm: fakeLlm(['Mi dispiace, non posso.']),
    });
    expect(res.ok).toBe(false);
  });
});
