/**
 * scaffold-catalog (RAG Fase 2) — il wizard riceve i nodi RILEVANTI al goal con
 * i CAMPI config, non il catalogo completo. Core garantiti + top-k retrieved.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

// Catalogo di test: alcuni core + alcuni di dominio.
const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'trigger_webhook',
    type: 'trigger',
    label: 'Webhook',
    description: 'Avvia da HTTP.',
    fields: [{ key: 'path', label: 'Path', type: 'string', required: true }],
  },
  {
    defId: 'logic_if',
    type: 'logic',
    label: 'If',
    description: 'Ramo condizionale.',
    fields: [{ key: 'expr', label: 'Expr', type: 'string', required: true }],
  },
  {
    defId: 'action_send_email',
    type: 'action',
    label: 'Email',
    description: 'Invia email SMTP.',
    fields: [
      { key: 'to', label: 'To', type: 'string', required: true },
      { key: 'subject', label: 'Subj', type: 'string', required: false, options: ['a', 'b'] },
    ],
  },
  {
    defId: 'action_pdf_parse',
    type: 'action',
    label: 'PDF',
    description: 'Estrae testo da PDF.',
    fields: [{ key: 'src', label: 'Src', type: 'string', required: true }],
  },
  {
    defId: 'community_slack',
    type: 'action',
    label: 'Slack',
    description: 'Posta su Slack.',
    fields: [{ key: 'channel', label: 'Ch', type: 'string', required: true }],
  },
];

vi.mock('./tenant-catalog.js', () => ({ buildTenantCatalog: vi.fn(async () => CATALOG) }));
const retrieveMock = vi.fn();
vi.mock('./index.js', () => ({
  getCatalogRetriever: vi.fn(async () => ({ retrieve: retrieveMock })),
}));

const {
  buildScaffoldCatalogText,
  buildScaffoldCatalogEntries,
  formatScaffoldCatalogEntries,
  SCAFFOLD_CORE_DEFIDS,
} = await import('./scaffold-catalog.js');

describe('buildScaffoldCatalogText', () => {
  it('include i CAMPI config dei nodi (formatScaffoldEntry), non solo i nomi', async () => {
    retrieveMock.mockResolvedValue([
      {
        defId: 'action_send_email',
        type: 'action',
        label: 'Email',
        category: 'email',
        shortDesc: 'x',
        score: 1,
      },
    ]);
    const text = await buildScaffoldCatalogText('ws-1', 'manda email');
    expect(text).toContain('action_send_email (action):');
    expect(text).toContain('to:string(REQUIRED)'); // campo required
    expect(text).toContain('enum[a|b]'); // enum dal field options
  });

  it('passa i CORE (esistenti nel catalogo) come inUseDefIds → garantiti', async () => {
    retrieveMock.mockResolvedValue([]);
    await buildScaffoldCatalogText('ws-1', 'qualsiasi goal');
    const opts = retrieveMock.mock.calls[0]![1] as { inUseDefIds: string[]; k: number };
    // Solo i core presenti nel catalogo di test (webhook, if, email) — non quelli assenti.
    expect(opts.inUseDefIds).toContain('trigger_webhook');
    expect(opts.inUseDefIds).toContain('logic_if');
    expect(opts.inUseDefIds).not.toContain('trigger_imap'); // core ma non nel catalogo test
    expect(opts.k).toBeGreaterThanOrEqual(40);
  });

  it('mappa i defId retrieved ai NodeCatalogEntry completi; dedup; salta gli sconosciuti', async () => {
    retrieveMock.mockResolvedValue([
      {
        defId: 'action_pdf_parse',
        type: 'action',
        label: '',
        category: 'files',
        shortDesc: '',
        score: 3,
      },
      {
        defId: 'action_pdf_parse',
        type: 'action',
        label: '',
        category: 'files',
        shortDesc: '',
        score: 2,
      }, // dup
      {
        defId: 'ghost_inesistente',
        type: 'action',
        label: '',
        category: 'x',
        shortDesc: '',
        score: 1,
      }, // non in catalogo
    ]);
    const text = await buildScaffoldCatalogText('ws-1', 'estrai pdf');
    const lines = text.split('\n').filter(Boolean);
    expect(lines.filter((l) => l.startsWith('action_pdf_parse'))).toHaveLength(1); // dedup
    expect(text).not.toContain('ghost_inesistente'); // sconosciuto saltato
  });

  it('SCAFFOLD_CORE_DEFIDS contiene le fondamenta (trigger/logic/primitive)', () => {
    expect(SCAFFOLD_CORE_DEFIDS).toEqual(
      expect.arrayContaining([
        'trigger_webhook',
        'logic_if',
        'logic_loop',
        'action_http',
        'db_insert',
        'action_send_email',
      ]),
    );
  });
});

describe('buildScaffoldCatalogEntries (subset per la grammatica #1)', () => {
  it('🚨 ritorna gli ENTRY completi del subset, deduplicati, sconosciuti saltati', async () => {
    retrieveMock.mockResolvedValue([
      {
        defId: 'action_pdf_parse',
        type: 'action',
        label: '',
        category: 'files',
        shortDesc: '',
        score: 3,
      },
      {
        defId: 'action_pdf_parse',
        type: 'action',
        label: '',
        category: 'files',
        shortDesc: '',
        score: 2,
      }, // dup
      {
        defId: 'action_send_email',
        type: 'action',
        label: '',
        category: 'email',
        shortDesc: '',
        score: 1,
      },
      {
        defId: 'ghost_inesistente',
        type: 'action',
        label: '',
        category: 'x',
        shortDesc: '',
        score: 1,
      }, // non in catalogo
    ]);
    const entries = await buildScaffoldCatalogEntries('ws-1', 'estrai pdf e manda email');
    const ids = entries.map((e) => e.defId);
    expect(ids).toEqual(['action_pdf_parse', 'action_send_email']); // dedup + ordine + ghost saltato
    // sono i NodeCatalogEntry COMPLETI (con fields), non solo i nomi
    expect(entries[0]!.fields.some((f) => f.key === 'src')).toBe(true);
  });

  it('🚨 EQUIVALENZA: buildScaffoldCatalogText === formatScaffoldCatalogEntries(buildScaffoldCatalogEntries) — il refactor non cambia il prompt', async () => {
    retrieveMock.mockResolvedValue([
      {
        defId: 'action_send_email',
        type: 'action',
        label: '',
        category: 'email',
        shortDesc: '',
        score: 2,
      },
      {
        defId: 'community_slack',
        type: 'action',
        label: '',
        category: 'chat',
        shortDesc: '',
        score: 1,
      },
    ]);
    const text = await buildScaffoldCatalogText('ws-1', 'manda email e slack');
    retrieveMock.mockResolvedValue([
      {
        defId: 'action_send_email',
        type: 'action',
        label: '',
        category: 'email',
        shortDesc: '',
        score: 2,
      },
      {
        defId: 'community_slack',
        type: 'action',
        label: '',
        category: 'chat',
        shortDesc: '',
        score: 1,
      },
    ]);
    const viaEntries = formatScaffoldCatalogEntries(
      await buildScaffoldCatalogEntries('ws-1', 'manda email e slack'),
    );
    expect(viaEntries).toBe(text);
  });
});
