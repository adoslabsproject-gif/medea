/**
 * E2E integration test — Odoo 17 REALE. GATED.
 *
 * A differenza degli unit (`index.test.ts`, `mockedFetch`), questo blocco
 * colpisce un'istanza Odoo VERA e verifica end-to-end la regressione del bug
 * 2026-06-04: `crm.tag.name_create` NON è idempotente → throwa "Tag name
 * already exists!" sul tag duplicato. Il fix fa search-then-create. Qui lo
 * proviamo contro Odoo reale, rendendo la "verifica E2E" ripetibile in CI
 * invece di un run manuale una-tantum.
 *
 * Esecuzione (CI o locale con un Odoo 17 di test):
 *   ODOO_E2E=1 \
 *   ODOO_BASE_URL=https://odoo.example.com \
 *   ODOO_DB=mydb ODOO_LOGIN=admin ODOO_PASSWORD=*** \
 *   pnpm --filter @medea/engine-nodes-stdlib test -- odoo_create_lead/e2e
 *
 * Senza le env l'INTERO blocco è SKIPPATO (`describe.skipIf`) — la CI base
 * non richiede alcun Odoo. Nessun green fittizio: se le env mancano, i test
 * non vengono spacciati per "passati", vengono saltati esplicitamente.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { odooCreateLeadExecutor } from './executor.js';

const E2E =
  process.env.ODOO_E2E === '1' &&
  !!process.env.ODOO_BASE_URL &&
  !!process.env.ODOO_DB &&
  !!process.env.ODOO_LOGIN &&
  !!process.env.ODOO_PASSWORD;

const ctx = { tenantId: 'e2e', workflowId: 'e2e', runId: 'e2e', nodeId: 'e2e', secrets: {} };

function baseCfg(): Record<string, unknown> {
  return {
    baseUrl: process.env.ODOO_BASE_URL,
    database: process.env.ODOO_DB,
    login: process.env.ODOO_LOGIN,
    password: process.env.ODOO_PASSWORD,
    model: 'crm.lead',
  };
}

interface LeadOut {
  output: { success: boolean; leadId: number; tagIds: readonly number[] };
}

describe.skipIf(!E2E)('odoo_create_lead — E2E REALE contro Odoo 17 (gated ODOO_E2E=1)', () => {
  it('crea un lead con 2 tag nuovi → leadId valido + 2 tagIds', async () => {
    const stamp = Date.now();
    const res = (await odooCreateLeadExecutor(
      { ...baseCfg(), name: `E2E lead ${stamp}`, tagNames: `e2e-a-${stamp},e2e-b-${stamp}` },
      {},
      ctx,
    )) as LeadOut;
    expect(res.output.success).toBe(true);
    expect(res.output.leadId).toBeGreaterThan(0);
    expect(res.output.tagIds).toHaveLength(2);
  });

  it('IDEMPOTENZA TAG (regressione 2026-06-04): stesso tag su 2 run → reuse, niente "already exists"', async () => {
    const tag = `e2e-shared-${Date.now()}`;
    const first = (await odooCreateLeadExecutor(
      { ...baseCfg(), name: 'E2E idem #1', tagNames: tag },
      {},
      ctx,
    )) as LeadOut;
    expect(first.output.tagIds).toHaveLength(1);

    // Secondo lead con lo STESSO tag. Senza il fix search-then-create, Odoo
    // throwerebbe "Tag name already exists!" QUI. Con il fix → riusa lo stesso id.
    const second = (await odooCreateLeadExecutor(
      { ...baseCfg(), name: 'E2E idem #2', tagNames: tag },
      {},
      ctx,
    )) as LeadOut;
    expect(second.output.success).toBe(true);
    expect(second.output.tagIds).toEqual(first.output.tagIds); // stesso tag id riusato, no duplicato
  });
});
