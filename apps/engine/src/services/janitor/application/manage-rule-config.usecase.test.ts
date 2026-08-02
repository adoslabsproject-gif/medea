/**
 * Test 2026-grade — application/manage-rule-config.usecase.ts (CRUD UI-driven).
 *
 * 🚨 LIST EFFECTIVE: rules + config (persistito OR default fallback).
 *    Bug = UI mostra "default" anche dopo l'edit utente.
 *
 * 🚨 PATCH VALIDATION: cron + params (schema) + maxRowsPerRun range.
 *    Bug = UI accetta cron invalido → scheduler crash silenzioso.
 *
 * 🚨 PATCH AUTO-CREATE: se config NON esiste, upsert default + patch dopo.
 *
 * 🚨 AUDIT: ogni patch + reset emette audit log con changedFields.
 *
 * 🚨 RESET: delete persisted → torna ai default code rule.
 *
 * 🚨 SECURITY: rule not in registry → throw fail-loud.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManageRuleConfigUseCase } from './manage-rule-config.usecase.js';
import { SYSTEM_REF } from '@/services/janitor/domain/index.js';
import type {
  IRuleRegistry,
  IRuleConfigRepository,
  IAuditEmitter,
} from '@/services/janitor/ports/index.js';
import type { CodeRule, RuleConfig } from '@/services/janitor/domain/index.js';

const mkCodeRule = (id: string): CodeRule => ({
  kind: 'code',
  id,
  title: id,
  description: 'd',
  defaultDataSource: SYSTEM_REF,
  targetTable: 'runs',
  targetPkColumn: 'id',
  tags: [],
  paramsSchema: [
    {
      name: 'threshold',
      type: 'number',
      label: 'T',
      required: true,
      default: 30,
      min: 1,
      max: 100,
    },
  ],
  defaultSeverity: 'critical',
  defaultSchedule: '0 * * * *',
  defaultMaxRowsPerRun: 100,
  detect: async () => [],
});

const mkConfig = (over: Partial<RuleConfig> = {}): RuleConfig => ({
  ruleId: over.ruleId ?? 'rule.a',
  tenantId: over.tenantId ?? 't1',
  enabled: over.enabled ?? true,
  schedule: over.schedule ?? '0 * * * *',
  dataSourceRef: over.dataSourceRef ?? SYSTEM_REF,
  maxRowsPerRun: over.maxRowsPerRun ?? 100,
  severity: over.severity ?? 'critical',
  params: over.params ?? { threshold: 30 },
  notifyOnDetection: over.notifyOnDetection ?? false,
  updatedAt: over.updatedAt ?? '2026-06-08T00:00:00.000Z',
});

let registry: IRuleRegistry;
let configRepo: IRuleConfigRepository;
let audit: IAuditEmitter;
let uc: ManageRuleConfigUseCase;

beforeEach(() => {
  registry = {
    get: vi.fn(),
    listAll: vi.fn(() => []),
    listForTenant: vi.fn(() => []),
    registerCodeRule: vi.fn(),
    registerDslRule: vi.fn(),
    unregisterDslRule: vi.fn(),
  };
  configRepo = {
    list: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    get: vi.fn(async () => null),
    upsert: vi.fn(async () => {
      /* noop */
    }),
    patch: vi.fn(async (id, tid) => mkConfig({ ruleId: id, tenantId: tid })),
    delete: vi.fn(async () => {
      /* noop */
    }),
  };
  audit = {
    emit: vi.fn(async () => {
      /* noop */
    }),
  };
  uc = new ManageRuleConfigUseCase(registry, configRepo, audit);
});

describe('🚨 listForTenant — rules + effective config', () => {
  it('🚨 rule SENZA config persistita → ritorna default + isPersistedConfig=false', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkCodeRule('rule.a')]);
    (configRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const out = await uc.listForTenant('t1');
    expect(out).toHaveLength(1);
    expect(out[0]!.isPersistedConfig).toBe(false);
    expect(out[0]!.config.enabled).toBe(true); // default
    expect(out[0]!.config.params).toEqual({ threshold: 30 }); // default from schema
  });

  it('🚨 rule CON config persistita → ritorna quella + isPersistedConfig=true', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([mkCodeRule('rule.a')]);
    (configRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkConfig({ ruleId: 'rule.a', enabled: false }),
    ]);
    const out = await uc.listForTenant('t1');
    expect(out[0]!.isPersistedConfig).toBe(true);
    expect(out[0]!.config.enabled).toBe(false);
  });

  it('🚨 multiple rules mix persisted/default', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([
      mkCodeRule('rule.a'),
      mkCodeRule('rule.b'),
    ]);
    (configRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      mkConfig({ ruleId: 'rule.a', enabled: false }),
    ]);
    const out = await uc.listForTenant('t1');
    expect(out.find((o) => o.rule.id === 'rule.a')!.isPersistedConfig).toBe(true);
    expect(out.find((o) => o.rule.id === 'rule.b')!.isPersistedConfig).toBe(false);
  });

  it('🚨 zero rules → []', async () => {
    (registry.listForTenant as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const out = await uc.listForTenant('t1');
    expect(out).toEqual([]);
  });
});

describe('🚨 getEffective — singolo lookup', () => {
  it('🚨 rule esistente persistita → ritorna persisted', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(mkCodeRule('rule.a'));
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(mkConfig({ enabled: false }));
    const out = await uc.getEffective('rule.a', 't1');
    expect(out!.isPersistedConfig).toBe(true);
    expect(out!.config.enabled).toBe(false);
  });

  it('🚨 rule esistente NO persisted → default + isPersistedConfig=false', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(mkCodeRule('rule.a'));
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const out = await uc.getEffective('rule.a', 't1');
    expect(out!.isPersistedConfig).toBe(false);
  });

  it('🚨 rule MAI esistita → null', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const out = await uc.getEffective('mai', 't1');
    expect(out).toBeNull();
  });
});

describe('🚨 patch — validation guards', () => {
  beforeEach(() => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(mkCodeRule('rule.a'));
  });

  it('🚨 rule not in registry → THROW', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await expect(
      uc.patch({
        ruleId: 'mai',
        tenantId: 't1',
        patch: { enabled: false },
      }),
    ).rejects.toThrow(/non trovata/);
  });

  it('🚨 schedule cron invalido → THROW', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { schedule: 'NOT A CRON' },
      }),
    ).rejects.toThrow(/Schedule non valido/);
  });

  it('🚨 schedule cron valido → ok', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { schedule: '0 * * * *' },
      }),
    ).resolves.toBeDefined();
  });

  it('🚨 params VIOLATES schema (threshold>max) → THROW con messaggio specifico', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { params: { threshold: 500 } },
      }),
    ).rejects.toThrow(/Parametri invalidi/);
  });

  it('🚨 params nel range → ok', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { params: { threshold: 50 } },
      }),
    ).resolves.toBeDefined();
  });

  it('🚨 maxRowsPerRun = 0 → THROW (< 1)', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { maxRowsPerRun: 0 },
      }),
    ).rejects.toThrow(/intero tra 1 e 100/);
  });

  it('🚨 SECURITY: maxRowsPerRun > 100_000 → THROW (DoS guard)', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { maxRowsPerRun: 999_999 },
      }),
    ).rejects.toThrow(/100/);
  });

  it('🚨 maxRowsPerRun float (non integer) → THROW', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { maxRowsPerRun: 50.5 },
      }),
    ).rejects.toThrow(/intero/);
  });

  it('🚨 maxRowsPerRun boundary 1 ok', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { maxRowsPerRun: 1 },
      }),
    ).resolves.toBeDefined();
  });

  it('🚨 maxRowsPerRun boundary 100000 ok', async () => {
    await expect(
      uc.patch({
        ruleId: 'rule.a',
        tenantId: 't1',
        patch: { maxRowsPerRun: 100_000 },
      }),
    ).resolves.toBeDefined();
  });
});

describe('🚨 patch — auto-create default config', () => {
  beforeEach(() => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(mkCodeRule('rule.a'));
  });

  it('🚨 config NON esiste → upsert default PRIMA del patch', async () => {
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await uc.patch({ ruleId: 'rule.a', tenantId: 't1', patch: { enabled: false } });
    expect(configRepo.upsert).toHaveBeenCalled();
    expect(configRepo.patch).toHaveBeenCalled();
  });

  it("🚨 config GIA' esiste → patch diretto (no upsert default)", async () => {
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(mkConfig());
    await uc.patch({ ruleId: 'rule.a', tenantId: 't1', patch: { enabled: false } });
    expect(configRepo.upsert).not.toHaveBeenCalled();
    expect(configRepo.patch).toHaveBeenCalled();
  });
});

describe('🚨 patch — audit emission', () => {
  beforeEach(() => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(mkCodeRule('rule.a'));
    (configRepo.get as ReturnType<typeof vi.fn>).mockResolvedValue(mkConfig());
  });

  it('🚨 audit emesso con changedFields', async () => {
    await uc.patch({
      ruleId: 'rule.a',
      tenantId: 't1',
      patch: { enabled: false, severity: 'warning' },
      updatedBy: 'alice',
    });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'janitor.rule_config.patched',
        resourceType: 'janitor_rule_config',
        resourceId: 'rule.a',
        tenantId: 't1',
        actorId: 'alice',
        metadata: { changedFields: ['enabled', 'severity'] },
      }),
    );
  });

  it('🚨 audit senza updatedBy → no actorId field', async () => {
    await uc.patch({
      ruleId: 'rule.a',
      tenantId: 't1',
      patch: { enabled: false },
    });
    const call = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect('actorId' in call).toBe(false);
  });
});

describe('🚨 resetToDefault', () => {
  beforeEach(() => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(mkCodeRule('rule.a'));
  });

  it('🚨 rule not in registry → THROW', async () => {
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await expect(uc.resetToDefault('mai', 't1')).rejects.toThrow(/non trovata/);
  });

  it('🚨 delete persisted + ritorna default', async () => {
    const out = await uc.resetToDefault('rule.a', 't1');
    expect(configRepo.delete).toHaveBeenCalledWith('rule.a', 't1');
    expect(out.params).toEqual({ threshold: 30 }); // default schema
    expect(out.enabled).toBe(true); // factory default
  });

  it('🚨 audit emesso reset', async () => {
    await uc.resetToDefault('rule.a', 't1', 'bob');
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'janitor.rule_config.reset',
        actorId: 'bob',
      }),
    );
  });

  it('🚨 audit senza updatedBy → no actorId field', async () => {
    await uc.resetToDefault('rule.a', 't1');
    const call = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect('actorId' in call).toBe(false);
  });
});
