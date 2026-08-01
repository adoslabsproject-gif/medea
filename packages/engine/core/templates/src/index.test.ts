import { describe, it, expect } from 'vitest';
import { WORKFLOW_TEMPLATES, WorkflowTemplateSchema, findTemplate, templatesByCategory } from './index.js';

describe('workflow templates', () => {
  it('every template validates against schema', () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const result = WorkflowTemplateSchema.safeParse(t);
      if (!result.success) {
        throw new Error(`${t.id} failed: ${result.error.message}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it('ids are unique', () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships ≥3 Italian-fiscal templates (moat seeded)', () => {
    const italian = WORKFLOW_TEMPLATES.filter((t) => t.category === 'fiscalita-italia');
    expect(italian.length).toBeGreaterThanOrEqual(2);
  });

  it('findTemplate works for known + unknown', () => {
    expect(findTemplate('tmpl_ai_summarize_endpoint')?.name).toContain('AI Summarize');
    expect(findTemplate('does-not-exist')).toBeUndefined();
  });

  it('templatesByCategory filters correctly', () => {
    const aiTpls = templatesByCategory('ai-orchestration');
    expect(aiTpls.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Guard template pizzeria (2026-07-06) — inchioda i due difetti classe:
 *  1. sintassi espressioni DRIFTATA `<id>.output.*` (non esiste nello scope
 *     dell'interprete: i riferimenti cross-nodo sono $node.<id>.json.*) —
 *     bug reale trovato E2E sul tenant pizzeria;
 *  2. databaseId placeholder incoerente fra nodi e tablesToCreate → il remap
 *     all'instantiate non aggancia e i nodi db falliscono a runtime.
 */
describe('tmpl_pizzeria_whatsapp_bot — contract anti-drift', () => {
  const tmpl = WORKFLOW_TEMPLATES.find((t) => t.id === 'tmpl_pizzeria_whatsapp_bot')!;

  it('esiste, featured, con trigger_whatsapp e 5 tabelle dichiarate', () => {
    expect(tmpl).toBeDefined();
    expect(tmpl.featured).toBe(true);
    expect(tmpl.nodes.some((n) => n.defId === 'trigger_whatsapp')).toBe(true);
    expect(tmpl.tablesToCreate).toHaveLength(5);
    expect(tmpl.tablesToCreate!.map((t) => t.name).sort()).toEqual(
      ['pizzeria_chat', 'pizzeria_clienti', 'pizzeria_info', 'pizzeria_menu', 'pizzeria_ordini'],
    );
  });

  it('🚨 nessuna espressione con la sintassi driftata `<id>.output.` nei config', () => {
    const blob = JSON.stringify(tmpl.nodes);
    // La forma corretta è $node.<id>.json.* — .output. dentro {{ }} è il drift.
    expect(blob).not.toMatch(/\{\{[^}]*\.output\./u);
    expect(blob).toContain('$node.wa_in.json.from');
  });

  it('🚨 databaseId coerente: ogni nodo db_* usa il placeholder dichiarato in tablesToCreate', () => {
    const declared = new Set(tmpl.tablesToCreate!.map((t) => t.databaseId));
    expect(declared.size).toBe(1); // un solo placeholder per il remap
    for (const n of tmpl.nodes) {
      const dbId = (n.config as Record<string, unknown>).databaseId;
      if (typeof dbId === 'string') expect(declared.has(dbId), `nodo ${n.id}`).toBe(true);
    }
  });

  it('🚨 ogni tabella referenziata dai nodi db_* è dichiarata in tablesToCreate', () => {
    const declared = new Set(tmpl.tablesToCreate!.map((t) => t.name));
    for (const n of tmpl.nodes) {
      const table = (n.config as Record<string, unknown>).table;
      if (typeof table === 'string') expect(declared.has(table), `nodo ${n.id} → tabella ${table}`).toBe(true);
    }
  });

  it('seedRows: menu 16 pizze + 1 riga info; MAI seed su clienti/ordini/chat (dati del tenant)', () => {
    const byName = new Map(tmpl.tablesToCreate!.map((t) => [t.name, t]));
    expect(byName.get('pizzeria_menu')!.seedRows).toHaveLength(16);
    expect(byName.get('pizzeria_info')!.seedRows).toHaveLength(1);
    for (const t of ['pizzeria_clienti', 'pizzeria_ordini', 'pizzeria_chat']) {
      expect(byName.get(t)!.seedRows).toBeUndefined();
    }
  });

  it('credenziali Meta VUOTE nel template (mai secret pre-compilati)', () => {
    const waIn = tmpl.nodes.find((n) => n.id === 'wa_in')!;
    const send = tmpl.nodes.find((n) => n.id === 'rispondi')!;
    expect((waIn.config as Record<string, unknown>).appSecret).toBe('');
    expect((send.config as Record<string, unknown>).accessToken).toBe('');
    expect((send.config as Record<string, unknown>).phoneNumberId).toBe('');
  });
});

/** Stessi contract del gemello WhatsApp, applicati alla variante Telegram. */
describe('tmpl_pizzeria_telegram_bot — contract anti-drift (variante demo)', () => {
  const tmpl = WORKFLOW_TEMPLATES.find((t) => t.id === 'tmpl_pizzeria_telegram_bot')!;

  it('esiste, featured, con trigger_telegram + integration_telegram_send e 5 tabelle', () => {
    expect(tmpl).toBeDefined();
    expect(tmpl.featured).toBe(true);
    expect(tmpl.nodes.some((n) => n.defId === 'trigger_telegram')).toBe(true);
    expect(tmpl.nodes.some((n) => n.defId === 'integration_telegram_send')).toBe(true);
    expect(tmpl.tablesToCreate).toHaveLength(5);
  });

  it('🚨 nessuna sintassi driftata `.output.` + riferimenti $node corretti', () => {
    const blob = JSON.stringify(tmpl.nodes);
    expect(blob).not.toMatch(/\{\{[^}]*\.output\./u);
    expect(blob).toContain('$node.tg_in.json.chatId');
  });

  it('🚨 stesso placeholder DB del gemello WhatsApp (tabelle CONDIVISE fra i due template)', () => {
    const wa = WORKFLOW_TEMPLATES.find((t) => t.id === 'tmpl_pizzeria_whatsapp_bot')!;
    const tgDb = new Set(tmpl.tablesToCreate!.map((t) => t.databaseId));
    const waDb = new Set(wa.tablesToCreate!.map((t) => t.databaseId));
    expect(tgDb).toEqual(waDb);
    // Stessi nomi tabella e STESSE colonne (drift di schema fra i gemelli = dati incompatibili)
    const shape = (tt: typeof tmpl.tablesToCreate) => JSON.stringify(
      tt!.map((t) => ({ name: t.name, columns: t.columns })).sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(shape(tmpl.tablesToCreate)).toBe(shape(wa.tablesToCreate));
  });

  it('🚨 ogni nodo db_* usa placeholder e tabelle dichiarate; secret vuoto nel trigger', () => {
    const declaredDb = new Set(tmpl.tablesToCreate!.map((t) => t.databaseId));
    const declaredTables = new Set(tmpl.tablesToCreate!.map((t) => t.name));
    for (const n of tmpl.nodes) {
      const cfg = n.config as Record<string, unknown>;
      if (typeof cfg.databaseId === 'string') expect(declaredDb.has(cfg.databaseId), `nodo ${n.id}`).toBe(true);
      if (typeof cfg.table === 'string') expect(declaredTables.has(cfg.table), `nodo ${n.id}`).toBe(true);
    }
    expect((tmpl.nodes.find((n) => n.id === 'tg_in')!.config as Record<string, unknown>).secretToken).toBe('');
  });
});

describe('template lead-gen B2B + opt-out — contract (2026-07-10)', () => {
  const lead = WORKFLOW_TEMPLATES.find((t) => t.id === 'tmpl_lead_gen_b2b')!;
  const oo = WORKFLOW_TEMPLATES.find((t) => t.id === 'tmpl_email_optout_handler')!;

  it('entrambi esistono con le tabelle dichiarate', () => {
    expect(lead).toBeDefined();
    expect(oo).toBeDefined();
    expect(lead.tablesToCreate!.map((t) => t.name).sort()).toEqual(['lead_contatti', 'opt_out']);
    expect(oo.tablesToCreate!.map((t) => t.name)).toEqual(['opt_out']);
  });

  it('🚨 sintassi espressioni $node (nessun .output. driftato)', () => {
    for (const t of [lead, oo]) {
      const blob = JSON.stringify(t.nodes);
      expect(blob, t.id).not.toMatch(/\{\{[^}]*\.output\./u);
    }
  });

  it('🚨 NESSUN dato sensibile: casella email vuota (host/username/from), password solo via secret', () => {
    const send = lead.nodes.find((n) => n.defId === 'action_send_email')!;
    const imap = oo.nodes.find((n) => n.defId === 'trigger_imap')!;
    for (const cfg of [send.config, imap.config] as Record<string, unknown>[]) {
      for (const k of ['host', 'username', 'from', 'replyTo']) {
        if (k in cfg) expect(cfg[k], `${k} deve essere vuoto`).toBe('');
      }
      // La password NON deve essere un valore letterale: solo il riferimento a secret.
      if ('password' in cfg) expect(cfg.password).toBe('{{ secrets.SMTP_PASSWORD }}');
    }
  });

  it('🚨 placeholder DB coerente: i nodi db_* usano lo stesso databaseId dichiarato', () => {
    const declared = new Set(lead.tablesToCreate!.map((t) => t.databaseId));
    expect(declared).toEqual(new Set(['crm_db']));
    for (const n of lead.nodes) {
      const dbId = (n.config as Record<string, unknown>).databaseId;
      if (typeof dbId === 'string') expect(declared.has(dbId), `nodo ${n.id}`).toBe(true);
    }
  });

  it('gate include dedup + opt-out (non ricontatta né viola STOP)', () => {
    const gate = lead.nodes.find((n) => n.id === 'gate')!;
    const cond = (gate.config as { condition: string }).condition;
    expect(cond).toContain('$node.dedup.json.rowCount === 0');
    expect(cond).toContain('$node.optout.json.rowCount === 0');
  });
});
