/**
 * CONTRACT TEST — feedback loop run→template→ranking + riuso negative
 * examples, sullo schema VERO (runMigrations, tabelle ai_workflow_templates
 * e ai_interactions reali). Niente CREATE TABLE duplicate nel test.
 *
 * Bug-bounty, non conferme:
 *   • il bump finisce nella COLONNA GIUSTA (success vs fail — un ok invertito
 *     qui esplode, non "passa comunque");
 *   • un workflow MODIFICATO dopo l'import NON bumpa (signature diversa:
 *     pairing strutturale onesto);
 *   • CONTRATTO writer↔reader dei negative: captureRejectedScaffold scrive il
 *     formato che buildNegativeFeedbackBlock parsa — se uno dei due diverge
 *     (il bug-classe "ingest scrive X, retrieval filtra Y"), il blocco esce
 *     vuoto e il test FALLISCE;
 *   • isolamento tenant dei negative.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let sqliteInst: Database.Database;
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: sqliteInst }),
}));
vi.mock('@/lib/logger.js');

const { runMigrations } = await import('@/storage/migrate.js');
const { templateCache } = await import('./template-cache/template.service.js');
const { recordRunOutcomeForTemplate } = await import('./template-feedback.js');
const { captureRejectedScaffold, buildNegativeFeedbackBlock } = await import('./negative-example.js');
const { AIInteractionsService } = await import('@/services/ai-interactions.service.js');

const WF = {
  nodes: [
    { id: 'trig', defId: 'trigger_webhook' },
    { id: 'code', defId: 'action_run_js' },
    { id: 'mail', defId: 'action_send_email' },
  ],
  edges: [{ from: 'trig', to: 'code' }, { from: 'code', to: 'mail' }],
};

function counters(): { success: number; fail: number } {
  const row = sqliteInst.prepare(
    'SELECT success_count AS s, fail_count AS f FROM ai_workflow_templates LIMIT 1',
  ).get() as { s: number; f: number } | undefined;
  return { success: row?.s ?? -1, fail: row?.f ?? -1 };
}

beforeEach(() => {
  sqliteInst = new Database(':memory:');
  runMigrations();
  // I negative-example sono Track B (opt-in, default OFF): abilitiamo i tenant
  // usati nei test per verificare il contratto writer↔reader della cattura.
  const aiSvc = new AIInteractionsService();
  aiSvc.setCapturePreference('t-neg', true);
  aiSvc.setCapturePreference('t-altro', true);
  templateCache.save({
    promptText: 'webhook che esegue codice e manda email',
    workflow: { name: 'wf-gold', nodes: WF.nodes, edges: WF.edges },
    workflowJson: JSON.stringify({ name: 'wf-gold', ...WF }),
    embedding: null,
  });
});
afterEach(() => { sqliteInst.close(); });

describe('🚨🚨 feedback loop run→template (schema VERO)', () => {
  it('🚨 run SUCCESS sul grafo del template → bump success_count (e SOLO quello)', () => {
    expect(counters()).toEqual({ success: 0, fail: 0 });
    recordRunOutcomeForTemplate(WF, true);
    expect(counters()).toEqual({ success: 1, fail: 0 });
  });

  it('🚨 run FALLITO → bump fail_count (un ok invertito qui esplode)', () => {
    recordRunOutcomeForTemplate(WF, false);
    expect(counters()).toEqual({ success: 0, fail: 1 });
  });

  it('🚨 workflow MODIFICATO dopo l\'import (nodo in più) → NESSUN bump: non è più il template', () => {
    const modified = {
      nodes: [...WF.nodes, { id: 'extra', defId: 'logic_if' }],
      edges: [...WF.edges, { from: 'mail', to: 'extra' }],
    };
    recordRunOutcomeForTemplate(modified, true);
    expect(counters()).toEqual({ success: 0, fail: 0 });
  });

  it('DB rotto → mai throw (il feedback non deve MAI toccare l\'esito del run)', () => {
    sqliteInst.close();
    expect(() => recordRunOutcomeForTemplate(WF, true)).not.toThrow();
    sqliteInst = new Database(':memory:');
  });
});

describe('🚨🚨 negative examples: CONTRATTO writer (capture) ↔ reader (block)', () => {
  it('🚨 capture × 3 reject → il blocco contiene i codici per FREQUENZA con esempio recente', () => {
    const base = {
      tenantId: 't-neg',
      goal: 'workflow che manda email a tutti',
      rejectedWorkflow: { nodes: [], edges: [] },
      model: 'liara',
      latencyMs: 1000,
    };
    captureRejectedScaffold({ ...base, criticalIssues: [
      { code: 'MOCK_PLACEHOLDER', message: 'smtp.example.com non è un host reale' },
      { code: 'CIRCULAR_REFERENCE', message: 'nodo A referenzia B che non è upstream' },
    ] });
    captureRejectedScaffold({ ...base, criticalIssues: [
      { code: 'MOCK_PLACEHOLDER', message: 'bucket-name è un placeholder' },
    ] });
    captureRejectedScaffold({ ...base, criticalIssues: [
      { code: 'MOCK_PLACEHOLDER', message: 'noreply@company.com inventato' },
    ] });

    const block = buildNegativeFeedbackBlock('t-neg');
    // Il contratto: se il formato scritto da capture divergesse da quello
    // parsato qui, block sarebbe VUOTO e questi assert esplodono.
    expect(block).toContain('[MOCK_PLACEHOLDER] ×3');
    expect(block).toContain('[CIRCULAR_REFERENCE] ×1');
    expect(block).toContain('NON ripeterli');
  });

  it('tenant senza storia → blocco vuoto (cold start pulito, zero rumore nel prompt)', () => {
    expect(buildNegativeFeedbackBlock('t-vergine')).toBe('');
  });

  it('🚨 isolamento tenant: i reject di t-neg NON inquinano il prompt di t-altro', () => {
    captureRejectedScaffold({
      tenantId: 't-neg', goal: 'x', rejectedWorkflow: { nodes: [], edges: [] },
      criticalIssues: [{ code: 'DEAD_END_BRANCH', message: 'ramo morto' }],
      model: 'liara', latencyMs: 1,
    });
    expect(buildNegativeFeedbackBlock('t-altro')).toBe('');
  });
});
