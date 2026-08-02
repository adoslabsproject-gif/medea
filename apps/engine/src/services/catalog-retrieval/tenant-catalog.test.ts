/**
 * tenant-catalog — i custom node PRIVATI del tenant entrano nel catalogo di
 * Liara (gap chiuso 2026-06-12). Solo i RUNNABLE (published_priv /
 * marketplace_published); i draft/candidate restano fuori (non eseguibili).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listCustomNodesMock = vi.fn();
vi.mock('@/services/custom-nodes/index.js', () => ({
  listCustomNodes: (...a: unknown[]) => listCustomNodesMock(...a),
  customNodeDefId: (slug: string) => `custom_${slug}`,
}));
// buildNodeCatalog reale è pesante; mockiamo un base minimo deterministico.
vi.mock('@/services/ai-scaffold/node-catalog.js', () => ({
  buildNodeCatalog: () => [
    {
      defId: 'trigger_webhook',
      type: 'trigger',
      label: 'Webhook',
      description: 'Avvia da HTTP.',
      fields: [],
    },
    {
      defId: 'action_send_email',
      type: 'action',
      label: 'Email',
      description: 'Invia email.',
      fields: [],
    },
  ],
}));
vi.mock('@/lib/logger.js');

const { buildTenantCatalog, listRunnableCustomEntries } = await import('./tenant-catalog.js');

beforeEach(() => {
  listCustomNodesMock.mockReset();
});

function customNode(
  slug: string,
  status: string,
  displayName = slug,
  description = 'desc',
): Record<string, unknown> {
  return {
    id: `id-${slug}`,
    slug,
    displayName,
    description,
    category: 'Custom',
    semver: '1.0.0',
    status,
  };
}

describe('listRunnableCustomEntries', () => {
  it('solo RUNNABLE (published_priv / marketplace_published) — draft/candidate esclusi', async () => {
    listCustomNodesMock.mockResolvedValue({
      items: [
        customNode('sconto_fedelta', 'published_priv'),
        customNode('bozza', 'draft'),
        customNode('in_review', 'candidate'),
        customNode('pubblicato_mkt', 'marketplace_published'),
      ],
      total: 4,
    });
    const entries = await listRunnableCustomEntries('ws-1');
    const defIds = entries.map((e) => e.defId);
    expect(defIds).toContain('custom_sconto_fedelta');
    expect(defIds).toContain('custom_pubblicato_mkt');
    expect(defIds).not.toContain('custom_bozza');
    expect(defIds).not.toContain('custom_in_review');
  });

  it('mappa a NodeCatalogEntry: defId custom_<slug>, type action, description preservata', async () => {
    listCustomNodesMock.mockResolvedValue({
      items: [
        customNode('calc_iva', 'published_priv', 'Calcola IVA', "Scorpora l'IVA da un totale."),
      ],
      total: 1,
    });
    const [e] = await listRunnableCustomEntries('ws-1');
    expect(e!.defId).toBe('custom_calc_iva');
    expect(e!.type).toBe('action');
    expect(e!.label).toBe('Calcola IVA');
    expect(e!.description).toBe("Scorpora l'IVA da un totale.");
  });

  it('fail-soft: se listCustomNodes esplode → [] (catalogo base resta valido)', async () => {
    listCustomNodesMock.mockRejectedValue(new Error('db locked'));
    expect(await listRunnableCustomEntries('ws-1')).toEqual([]);
  });
});

describe('buildTenantCatalog', () => {
  it('base (sistema) + custom runnable, fusi', async () => {
    listCustomNodesMock.mockResolvedValue({
      items: [customNode('mio_nodo', 'published_priv')],
      total: 1,
    });
    const cat = await buildTenantCatalog('ws-1');
    const defIds = cat.map((e) => e.defId);
    expect(defIds).toContain('trigger_webhook'); // base
    expect(defIds).toContain('action_send_email'); // base
    expect(defIds).toContain('custom_mio_nodo'); // custom privato
  });

  it('nessun custom → ritorna il catalogo base intatto', async () => {
    listCustomNodesMock.mockResolvedValue({ items: [], total: 0 });
    const cat = await buildTenantCatalog('ws-1');
    expect(cat.map((e) => e.defId)).toEqual(['trigger_webhook', 'action_send_email']);
  });
});
