/**
 * Tests per ClientPortalService — modalità portal cliente del viewer-share.
 *
 * Invarianti CRITICALI (sicurezza + audit + GDPR):
 *  - Token mode='portal' obbligatorio per verify() (legacy readonly rejected)
 *  - Token revocato → verify ritorna null (instant kill switch)
 *  - Token expired → verify ritorna null
 *  - Cross-tenant escalation impossibile (token bound to tenant)
 *  - Default-deny: senza workflowIds/workflowTags → listVisibleWorkflows = []
 *  - Run gating: 3 condizioni AND (allowRun + visible + trigger whitelisted)
 *  - Trigger whitelist default = ['trigger_manual'] solo (no webhook/cron via portal)
 *  - canRun=true solo se workflow ha trigger nei tipi consentiti
 *  - access_count incrementato + last_accessed_at aggiornato a ogni verify
 *  - Audit log scritto su create + auditPortalRun
 *  - Permissions JSON malformed → fallback ai default safe (deny)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks per condividere lo state DB fake.
const m = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const workflows: Record<string, unknown>[] = [];
  const auditLog: Record<string, unknown>[] = [];
  return { rows, workflows, auditLog };
});

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      prepare: (sql: string) => ({
        run: (...params: unknown[]) => {
          if (sql.startsWith('INSERT INTO viewer_share_tokens')) {
            const [id, tenant_id, token, name, permissions_json, created_by, created_at, expires_at] = params;
            m.rows.push({
              id, tenant_id, token, name, mode: 'portal',
              permissions_json, created_by, created_at, expires_at,
              revoked_at: null, last_accessed_at: null, access_count: 0,
            });
            return { changes: 1 };
          }
          if (sql.startsWith('UPDATE viewer_share_tokens')) {
            // access_count + last_accessed_at bump
            const [last, id] = params as [string, string];
            const row = m.rows.find((r) => r.id === id);
            if (row) {
              row.last_accessed_at = last;
              row.access_count = (row.access_count as number) + 1;
            }
            return { changes: row ? 1 : 0 };
          }
          return { changes: 0 };
        },
        get: (...params: unknown[]) => {
          if (sql.includes('viewer_share_tokens')) {
            const [tenantId, token] = params;
            return m.rows.find((r) => r.tenant_id === tenantId && r.token === token);
          }
          return undefined;
        },
        all: (...params: unknown[]) => {
          if (sql.includes('FROM workflows')) {
            const tenantId = params[0];
            let result = m.workflows.filter((w) => w.tenant_id === tenantId);
            // workflowIds IN(...) — params[1..n]
            if (params.length > 1) {
              const ids = params.slice(1);
              result = result.filter((w) => ids.includes(w.id));
            }
            return result;
          }
          return [];
        },
      }),
    },
  }),
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: class {
    async append(entry: Record<string, unknown>): Promise<void> {
      m.auditLog.push(entry);
    }
  },
}));

import { ClientPortalService, type PortalPermissions } from './client-portal.service.js';

beforeEach(() => {
  m.rows.length = 0;
  m.workflows.length = 0;
  m.auditLog.length = 0;
});

function addWorkflow(opts: {
  id: string;
  tenantId?: string;
  name?: string;
  enabled?: boolean;
  tags?: string[];
  triggerType?: string;
}): void {
  m.workflows.push({
    id: opts.id,
    tenant_id: opts.tenantId ?? 'tenant-a',
    name: opts.name ?? opts.id,
    description: null,
    enabled: opts.enabled === false ? 0 : 1,
    tags_json: opts.tags ? JSON.stringify(opts.tags) : null,
    nodes_json: JSON.stringify([{ id: 'n1', defId: opts.triggerType ?? 'trigger_manual' }]),
    updated_at: '2026-05-29T10:00:00Z',
  });
}

describe('ClientPortalService — create', () => {
  it('crea token con mode=portal + permissions persisted', async () => {
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'Cliente Acme',
      permissions: { workflowIds: ['wf-1'], allowRun: true },
    });
    expect(t.mode).toBe('portal');
    expect(t.tenantId).toBe('tenant-a');
    expect(t.token.length).toBe(64); // 32 bytes hex
    expect(t.permissions.workflowIds).toEqual(['wf-1']);
    expect(t.permissions.allowRun).toBe(true);
  });

  it('default permissions: allowRun=false, allowedTriggerTypes=manual, showHistory/Canvas=true', async () => {
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'Test',
      permissions: { workflowIds: ['wf-1'] },
    });
    expect(t.permissions.allowRun).toBe(false);
    expect(t.permissions.allowedTriggerTypes).toEqual(['trigger_manual']);
    expect(t.permissions.showHistory).toBe(true);
    expect(t.permissions.showLiveCanvas).toBe(true);
  });

  it('audit log scritto con permissions in metadata', async () => {
    const svc = new ClientPortalService();
    await svc.create('tenant-a', {
      name: 'Cliente Beta',
      permissions: { workflowIds: ['wf-2'], allowRun: true },
      createdBy: 'admin-1',
    });
    expect(m.auditLog).toHaveLength(1);
    const entry = m.auditLog[0]!;
    expect(entry.action).toBe('client_portal.create');
    expect(entry.actorId).toBe('admin-1');
    const meta = entry.metadata as Record<string, unknown>;
    expect((meta.permissions as PortalPermissions).workflowIds).toEqual(['wf-2']);
  });

  it('expiresInDays calcola correttamente expires_at', async () => {
    const svc = new ClientPortalService();
    const before = Date.now();
    const t = await svc.create('tenant-a', {
      name: 'Test',
      permissions: { workflowIds: ['wf-1'] },
      expiresInDays: 7,
    });
    const expiresAt = new Date(t.expiresAt!).getTime();
    const expectedMin = before + 7 * 24 * 60 * 60 * 1000 - 1000;
    const expectedMax = before + 7 * 24 * 60 * 60 * 1000 + 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });
});

describe('ClientPortalService — verify', () => {
  it('token valido in portal mode → ritorna PortalToken + bump access', async () => {
    const svc = new ClientPortalService();
    const created = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1'] } });
    const verified = svc.verify('tenant-a', created.token);
    expect(verified).not.toBeNull();
    expect(verified!.id).toBe(created.id);
    expect(verified!.accessCount).toBe(1); // bump da 0 a 1
  });

  it('token wrong tenant → null (cross-tenant escalation impossibile)', async () => {
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1'] } });
    const verified = svc.verify('tenant-b', t.token);
    expect(verified).toBeNull();
  });

  it('token revocato → null', async () => {
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1'] } });
    // Simula revoke marcando il row
    m.rows[0]!.revoked_at = new Date().toISOString();
    expect(svc.verify('tenant-a', t.token)).toBeNull();
  });

  it('token expired → null', async () => {
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1'] } });
    m.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(svc.verify('tenant-a', t.token)).toBeNull();
  });

  it('token con mode=readonly (legacy) → null (richiede portal mode)', () => {
    const svc = new ClientPortalService();
    m.rows.push({
      id: 'legacy', tenant_id: 'tenant-a', token: 'legacy-token-readonly',
      name: 'Legacy', mode: 'readonly', permissions_json: null,
      created_by: null, created_at: '2026-01-01', expires_at: null,
      revoked_at: null, last_accessed_at: null, access_count: 0,
    });
    expect(svc.verify('tenant-a', 'legacy-token-readonly')).toBeNull();
  });

  it('token sconosciuto → null', () => {
    const svc = new ClientPortalService();
    expect(svc.verify('tenant-a', 'nonexistent-token')).toBeNull();
  });
});

describe('ClientPortalService — listVisibleWorkflows (filtering)', () => {
  it('default-deny: nessuna permission → []', async () => {
    const svc = new ClientPortalService();
    addWorkflow({ id: 'wf-1' });
    const t = await svc.create('tenant-a', { name: 'T', permissions: {} });
    expect(svc.listVisibleWorkflows(t)).toEqual([]);
  });

  it('workflowIds esplicita → filtra by ID', async () => {
    addWorkflow({ id: 'wf-1', name: 'Visibile' });
    addWorkflow({ id: 'wf-2', name: 'Nascosto' });
    addWorkflow({ id: 'wf-3', name: 'AltroVisibile' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1', 'wf-3'] } });
    const result = svc.listVisibleWorkflows(t);
    expect(result.map((w) => w.id).sort()).toEqual(['wf-1', 'wf-3']);
  });

  it('workflowTags filter (no IDs) → mostra workflow con tag corrispondente', async () => {
    addWorkflow({ id: 'wf-1', name: 'A', tags: ['client-facing', 'prod'] });
    addWorkflow({ id: 'wf-2', name: 'B', tags: ['internal'] });
    addWorkflow({ id: 'wf-3', name: 'C', tags: ['client-facing'] });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowTags: ['client-facing'] } });
    const result = svc.listVisibleWorkflows(t);
    expect(result.map((w) => w.id).sort()).toEqual(['wf-1', 'wf-3']);
  });

  it('workflowIds ha precedenza su workflowTags (esplicita vince)', async () => {
    addWorkflow({ id: 'wf-1', tags: ['client-facing'] });
    addWorkflow({ id: 'wf-2', tags: ['client-facing'] });
    addWorkflow({ id: 'wf-3', tags: ['client-facing'] });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'T',
      permissions: { workflowIds: ['wf-1'], workflowTags: ['client-facing'] },
    });
    const result = svc.listVisibleWorkflows(t);
    expect(result.map((w) => w.id)).toEqual(['wf-1']);
  });

  it('canRun=true SOLO se allowRun + trigger nei tipi consentiti', async () => {
    addWorkflow({ id: 'wf-manual', triggerType: 'trigger_manual' });
    addWorkflow({ id: 'wf-webhook', triggerType: 'trigger_webhook' });
    addWorkflow({ id: 'wf-cron', triggerType: 'trigger_cron' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'T',
      permissions: { workflowIds: ['wf-manual', 'wf-webhook', 'wf-cron'], allowRun: true },
    });
    const result = svc.listVisibleWorkflows(t);
    const byId = Object.fromEntries(result.map((w) => [w.id, w]));
    expect(byId['wf-manual']!.canRun).toBe(true);
    expect(byId['wf-webhook']!.canRun).toBe(false); // webhook NON in trigger_manual default
    expect(byId['wf-cron']!.canRun).toBe(false);
  });

  it('allowedTriggerTypes custom → canRun rispettato', async () => {
    addWorkflow({ id: 'wf-webhook', triggerType: 'trigger_webhook' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'T',
      permissions: {
        workflowIds: ['wf-webhook'],
        allowRun: true,
        allowedTriggerTypes: ['trigger_webhook', 'trigger_manual'],
      },
    });
    expect(svc.listVisibleWorkflows(t)[0]!.canRun).toBe(true);
  });

  it('allowRun=false (default) → tutti canRun=false anche se trigger manual', async () => {
    addWorkflow({ id: 'wf-1', triggerType: 'trigger_manual' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1'] } });
    expect(svc.listVisibleWorkflows(t)[0]!.canRun).toBe(false);
  });

  it('tags parsing safe vs JSON malformed', async () => {
    m.workflows.push({
      id: 'wf-broken', tenant_id: 'tenant-a', name: 'Broken', description: null, enabled: 1,
      tags_json: 'not-json-{', nodes_json: '[]', updated_at: '2026-01-01',
    });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-broken'] } });
    const result = svc.listVisibleWorkflows(t);
    expect(result).toHaveLength(1);
    expect(result[0]!.tags).toEqual([]);
  });
});

describe('ClientPortalService — canRunWorkflow (gating)', () => {
  it('allowRun=false → reason esplicito', async () => {
    addWorkflow({ id: 'wf-1', triggerType: 'trigger_manual' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', { name: 'T', permissions: { workflowIds: ['wf-1'] } });
    const result = svc.canRunWorkflow(t, { id: 'wf-1', nodesJson: JSON.stringify([{ defId: 'trigger_manual' }]) });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/allowRun=false/);
  });

  it('workflow NON visibile al token → reason "non visibile"', async () => {
    addWorkflow({ id: 'wf-1', triggerType: 'trigger_manual' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'T',
      permissions: { workflowIds: ['wf-OTHER'], allowRun: true },
    });
    const result = svc.canRunWorkflow(t, { id: 'wf-1', nodesJson: '[]' });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/non visibile/);
  });

  it('trigger type non whitelisted → reason "non ha trigger compatibili"', async () => {
    addWorkflow({ id: 'wf-1', triggerType: 'trigger_webhook' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'T',
      permissions: { workflowIds: ['wf-1'], allowRun: true },
    });
    const result = svc.canRunWorkflow(t, {
      id: 'wf-1',
      nodesJson: JSON.stringify([{ defId: 'trigger_webhook' }]),
    });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/trigger compatibili/);
  });

  it('happy path → ok:true', async () => {
    addWorkflow({ id: 'wf-1', triggerType: 'trigger_manual' });
    const svc = new ClientPortalService();
    const t = await svc.create('tenant-a', {
      name: 'T',
      permissions: { workflowIds: ['wf-1'], allowRun: true },
    });
    const result = svc.canRunWorkflow(t, {
      id: 'wf-1',
      nodesJson: JSON.stringify([{ defId: 'trigger_manual' }]),
    });
    expect(result.ok).toBe(true);
  });
});

describe('ClientPortalService — auditPortalRun', () => {
  it('scrive audit log con portalTokenId + workflowId + runId', async () => {
    const svc = new ClientPortalService();
    await svc.auditPortalRun({
      tenantId: 'tenant-a',
      tokenId: 'tok-1',
      workflowId: 'wf-1',
      runId: 'run-1',
      triggerInputSummary: { email: 'redacted' },
    });
    expect(m.auditLog).toHaveLength(1);
    const entry = m.auditLog[0]!;
    expect(entry.action).toBe('client_portal.workflow_run');
    expect(entry.resourceId).toBe('run-1');
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.portalTokenId).toBe('tok-1');
    expect(meta.workflowId).toBe('wf-1');
  });

  it('triggerInputSummary undefined → metadata.triggerInput=null (no leak)', async () => {
    const svc = new ClientPortalService();
    await svc.auditPortalRun({
      tenantId: 'tenant-a',
      tokenId: 'tok-1',
      workflowId: 'wf-1',
      runId: 'run-1',
    });
    const meta = m.auditLog[0]!.metadata as Record<string, unknown>;
    expect(meta.triggerInput).toBeNull();
  });
});

describe('computeExposedFields — Sprint 3 field whitelist', () => {
  // Import dinamico per evitare di rompere il tipo m.* hoisted
  it('NodeDef senza exposeToClient → 0 fields', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'send_email', config: { to: 'a@b.it' } }],
      nodeDefs: [{ id: 'send_email', configFields: [{ key: 'to', label: 'A', type: 'text' }] }],
    };
    expect(computeExposedFields(wf)).toEqual([]);
  });

  it('field con exposeToClient=true → ritorna ExposedFieldDescriptor', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'send_email', label: 'Invio email', config: { to: 'a@b.it' } }],
      nodeDefs: [{ id: 'send_email', configFields: [{ key: 'to', label: 'Destinatario', exposeToClient: true, type: 'text' }] }],
    };
    const result = computeExposedFields(wf);
    expect(result).toHaveLength(1);
    expect(result[0]!.nodeId).toBe('n1');
    expect(result[0]!.nodeLabel).toBe('Invio email');
    expect(result[0]!.fieldKey).toBe('to');
    expect(result[0]!.label).toBe('Destinatario');
    expect(result[0]!.currentValue).toBe('a@b.it');
    expect(result[0]!.redacted).toBe(false);
  });

  it('clientLabel override → ha precedenza sulla label tecnica', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'send_email', config: { to: 'x' } }],
      nodeDefs: [{ id: 'send_email', configFields: [{
        key: 'to', label: 'smtp_recipient', clientLabel: 'Email destinatario', exposeToClient: true, type: 'text',
      }] }],
    };
    expect(computeExposedFields(wf)[0]!.label).toBe('Email destinatario');
  });

  it('clientHint override → ha precedenza sull\'help tecnico', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'd', config: {} }],
      nodeDefs: [{ id: 'd', configFields: [{
        key: 'k', label: 'L', help: 'Dev hint', clientHint: 'Client friendly hint', exposeToClient: true,
      }] }],
    };
    expect(computeExposedFields(wf)[0]!.hint).toBe('Client friendly hint');
  });

  it('field type=secret con valore → REDACTED + redacted=true', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'send_email', config: { password: 'supersecret123' } }],
      nodeDefs: [{ id: 'send_email', configFields: [{
        key: 'password', label: 'Password', type: 'secret', exposeToClient: true,
      }] }],
    };
    const result = computeExposedFields(wf);
    expect(result[0]!.currentValue).toBe('••••••••');
    expect(result[0]!.redacted).toBe(true);
  });

  it('field type=secret SENZA valore → currentValue vuoto, redacted=false', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'd', config: {} }],
      nodeDefs: [{ id: 'd', configFields: [{ key: 'password', label: 'P', type: 'secret', exposeToClient: true }] }],
    };
    const result = computeExposedFields(wf);
    expect(result[0]!.currentValue).toBe('');
    expect(result[0]!.redacted).toBe(false);
  });

  it('actions[].configFields con exposeToClient → inclusi nel risultato', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'hubspot', config: { contact_email: 'x@y.it' } }],
      nodeDefs: [{
        id: 'hubspot',
        configFields: [{ key: 'auth_token', label: 'Auth' }],
        actions: [{ id: 'createContact', configFields: [{ key: 'contact_email', label: 'Email', exposeToClient: true, type: 'text' }] }],
      }],
    };
    const result = computeExposedFields(wf);
    expect(result).toHaveLength(1);
    expect(result[0]!.fieldKey).toBe('contact_email');
  });

  it('Node senza defId match → skip silenzioso (no crash)', async () => {
    const { computeExposedFields } = await import('./client-portal.service.js');
    const wf = {
      nodes: [{ id: 'n1', defId: 'unknown_def', config: {} }],
      nodeDefs: [{ id: 'other_def', configFields: [{ key: 'k', label: 'L', exposeToClient: true }] }],
    };
    expect(computeExposedFields(wf)).toEqual([]);
  });
});

describe('validateExposedFieldValue — Sprint 3 validation', () => {
  it('required + value vuoto → error', async () => {
    const { validateExposedFieldValue } = await import('./client-portal.service.js');
    const result = validateExposedFieldValue(
      { nodeId: 'n1', nodeLabel: 'N', fieldKey: 'k', label: 'L', type: 'text', required: true, currentValue: '', redacted: false },
      '   ',
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/obbligatorio/);
  });

  it('value > 10k char → error', async () => {
    const { validateExposedFieldValue } = await import('./client-portal.service.js');
    const result = validateExposedFieldValue(
      { nodeId: 'n1', nodeLabel: 'N', fieldKey: 'k', label: 'L', type: 'text', required: false, currentValue: '', redacted: false },
      'a'.repeat(10_001),
    );
    expect(result.ok).toBe(false);
  });

  it('pattern match fail → error con patternMessage custom', async () => {
    const { validateExposedFieldValue } = await import('./client-portal.service.js');
    const result = validateExposedFieldValue(
      {
        nodeId: 'n1', nodeLabel: 'N', fieldKey: 'k', label: 'L',
        type: 'text', required: false,
        pattern: '^[a-z]+@[a-z]+\\.it$',
        patternMessage: 'Email italiana richiesta',
        currentValue: '', redacted: false,
      },
      'not-an-email',
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe('Email italiana richiesta');
  });

  it('pattern match OK → ok:true', async () => {
    const { validateExposedFieldValue } = await import('./client-portal.service.js');
    const result = validateExposedFieldValue(
      {
        nodeId: 'n1', nodeLabel: 'N', fieldKey: 'k', label: 'L',
        type: 'text', required: false,
        pattern: '^[a-z]+@[a-z]+\\.it$',
        currentValue: '', redacted: false,
      },
      'mario@example.it',
    );
    expect(result.ok).toBe(true);
  });

  it('pattern malformed → non blocca (lasciamo passare per non bloccare il cliente)', async () => {
    const { validateExposedFieldValue } = await import('./client-portal.service.js');
    const result = validateExposedFieldValue(
      {
        nodeId: 'n1', nodeLabel: 'N', fieldKey: 'k', label: 'L',
        type: 'text', required: false,
        pattern: '[(broken regex',
        currentValue: '', redacted: false,
      },
      'qualsiasi valore',
    );
    expect(result.ok).toBe(true);
  });
});

describe('redactForAudit — PII safety nel log', () => {
  it('value vuoto → "(vuoto)"', async () => {
    const { redactForAudit } = await import('./client-portal.service.js');
    expect(redactForAudit('')).toBe('(vuoto)');
  });

  it('value popolato → length + first char (NO valore completo)', async () => {
    const { redactForAudit } = await import('./client-portal.service.js');
    expect(redactForAudit('mario.rossi@example.com')).toBe(`23 char inizia con 'm'`);
  });

  it('zero leak della stringa completa', async () => {
    const { redactForAudit } = await import('./client-portal.service.js');
    const secret = 'pa$$w0rd123';
    const redacted = redactForAudit(secret);
    expect(redacted).not.toContain(secret);
  });
});

describe('ClientPortalService — auditFieldUpdate', () => {
  it('audit log con portalTokenId + nodeId + fieldKey + oldRedacted; newValueLogged=false', async () => {
    const { ClientPortalService } = await import('./client-portal.service.js');
    const svc = new ClientPortalService();
    await svc.auditFieldUpdate({
      tenantId: 'tenant-a',
      tokenId: 'tok-1',
      workflowId: 'wf-1',
      nodeId: 'n1',
      fieldKey: 'destinatario_email',
      oldValueRedacted: `10 char inizia con 'a'`,
    });
    expect(m.auditLog).toHaveLength(1);
    const entry = m.auditLog[0]!;
    expect(entry.action).toBe('client_portal.field_update');
    expect(entry.resourceId).toBe('wf-1');
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.portalTokenId).toBe('tok-1');
    expect(meta.nodeId).toBe('n1');
    expect(meta.fieldKey).toBe('destinatario_email');
    expect(meta.oldValueRedacted).toBe(`10 char inizia con 'a'`);
    expect(meta.newValueLogged).toBe(false);
  });
});

describe('ClientPortalService — permissions parsing safety', () => {
  it('permissions_json malformed → fallback ai default safe', async () => {
    // Inject token con permissions_json corrotto
    m.rows.push({
      id: 'broken', tenant_id: 'tenant-a', token: 'tok-broken',
      name: 'Broken', mode: 'portal', permissions_json: 'not-json{',
      created_by: null, created_at: '2026-01-01', expires_at: null,
      revoked_at: null, last_accessed_at: null, access_count: 0,
    });
    const svc = new ClientPortalService();
    const t = svc.verify('tenant-a', 'tok-broken');
    expect(t).not.toBeNull();
    expect(t!.permissions.allowRun).toBe(false); // default safe
    expect(t!.permissions.workflowIds).toBeUndefined();
  });
});
