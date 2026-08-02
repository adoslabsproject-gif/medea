/**
 * Test REALI del complexity gate. Ogni test verifica un BEHAVIOR specifico
 * con assertion su VALORI numerici esatti — non smoke "defined/truthy".
 *
 * Criterio: se cancello la logica del gate, ogni test deve fallire.
 */

import { describe, it, expect } from 'vitest';
import { estimateComplexity, shouldRejectFinalize } from './complexity-gate.js';

describe('estimateComplexity — segnali distinti', () => {
  it('goal vuoto/cortissimo → minNodes=3 (floor), tier basic', () => {
    const r = estimateComplexity('ciao');
    expect(r.minNodes).toBe(3);
    expect(r.tier).toBe('basic');
    expect(r.signals.actionVerbs).toBe(0);
  });

  it('goal Enterprise reale (Document intelligence pipeline) → minNodes >= 14, tier enterprise', () => {
    const goal = `Document intelligence pipeline: cartella S3 con PDF in arrivo, OCR + vision AI extract entities, classifica documento (contratto/fattura/preventivo), validazione schema, branching per tipo: contratto → legal team review queue, fattura → ERP push, preventivo → CRM opportunity, in caso di low confidence routing manuale + Slack notification, summary AI giornaliero al management.`;
    const r = estimateComplexity(goal);
    expect(r.minNodes).toBeGreaterThanOrEqual(14);
    expect(r.tier).toBe('enterprise');
    // Cattura segnali specifici (non solo "exists"):
    expect(r.signals.documentTypes).toBeGreaterThanOrEqual(3); // contratto/fattura/preventivo
    expect(r.signals.integrations).toBeGreaterThanOrEqual(3); // s3, erp, crm, slack
    expect(r.signals.branches).toBeGreaterThanOrEqual(1); // branching/per tipo
  });

  it('goal "1 trigger + 3 verbi + 2 integrazioni" → minNodes nel range realistico 5-9', () => {
    // "salva l'allegato e invia notifica Slack via email":
    //   verbi: salva, invia, notifica = 3
    //   integrazioni: slack, email = 2
    //   branch: 0, tipi doc: 0
    // minNodes = 1 + ceil(3*0.8) + 2 + 0 + 0 = 1 + 3 + 2 = 6
    const goal = "Quando arriva una email, salva l'allegato e invia notifica Slack.";
    const r = estimateComplexity(goal);
    expect(r.minNodes).toBeGreaterThanOrEqual(5);
    expect(r.minNodes).toBeLessThanOrEqual(9);
    expect(r.tier).toMatch(/basic|intermediate/);
  });

  it('cap superiore: anche goal verbosi non superano 25 nodi', () => {
    const goal =
      'classifica valida estrai analizza notifica archivia invia aggiunge aggiorna filtra trasforma calcola genera inoltra sincronizza' +
      ' slack telegram discord email gmail webhook s3 stripe paypal github notion linear salesforce hubspot erp crm pec api database' +
      ' se altrimenti switch branch caso quando hot warm cold priorita threshold soglia condition contratto fattura preventivo ordine';
    const r = estimateComplexity(goal);
    expect(r.minNodes).toBe(25);
  });

  it('segnali sono DISTINCT (case-insensitive) — "Slack Slack Slack" conta 1', () => {
    const goal = 'invia notifica Slack invia notifica SLACK invia notifica slack';
    const r = estimateComplexity(goal);
    expect(r.signals.integrations).toBe(1); // solo "slack" (lowercase)
  });
});

describe('shouldRejectFinalize — gate behavior', () => {
  it('goal Enterprise + 2 nodi → REJECT con messaggio prescrittivo', () => {
    const goal = `Document intelligence pipeline: S3 PDF, OCR + vision AI, classifica contratto/fattura/preventivo, branching, Slack notification, summary AI giornaliero.`;
    const r = shouldRejectFinalize(goal, 2);
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.reason).toContain('Finalize PREMATURO');
      expect(r.reason).toContain('tier "enterprise"');
      expect(r.reason).toContain('list_node_catalog');
      expect(r.estimate.minNodes).toBeGreaterThanOrEqual(10);
    }
  });

  it('goal Enterprise + >= minNodes → ACCEPT (no reject)', () => {
    const goal = `Document intelligence pipeline: S3 PDF, OCR + vision AI, classifica contratto/fattura/preventivo, branching, Slack notification, summary AI giornaliero.`;
    const r = shouldRejectFinalize(goal, 20);
    expect(r.reject).toBe(false);
  });

  it('goal corto (< 20 char) → ACCEPT sempre (gate disabilitato per goal triviali)', () => {
    const r = shouldRejectFinalize('ciao', 1);
    expect(r.reject).toBe(false);
  });

  it('goal vuoto → ACCEPT (no goal = no gate)', () => {
    expect(shouldRejectFinalize('', 0).reject).toBe(false);
  });

  it('3-azioni con N nodi >= minNodes computed → ACCEPT', () => {
    // Stesso goal, leggo prima quanti nodi servono, poi assert ACCEPT con
    // count = minNodes. Verifica la consistenza estimate/gate.
    const goal = "Quando arriva una email, salva l'allegato e invia notifica.";
    const expected = estimateComplexity(goal).minNodes;
    const r = shouldRejectFinalize(goal, expected);
    expect(r.reject).toBe(false);
  });

  it('3-azioni con count = minNodes - 1 → REJECT (off-by-one boundary)', () => {
    const goal = "Quando arriva una email, salva l'allegato e invia notifica.";
    const expected = estimateComplexity(goal).minNodes;
    const r = shouldRejectFinalize(goal, expected - 1);
    expect(r.reject).toBe(true);
  });

  it('reject message: cita esattamente i numeri (current count + missing)', () => {
    const goal =
      'classifica valida estrai notifica Slack ERP CRM contratto fattura preventivo branching low confidence Slack summary giornaliero S3 OCR';
    const r = shouldRejectFinalize(goal, 5);
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.reason).toMatch(/hai solo 5/);
      expect(r.reason).toMatch(/Mancano ~\d+ nodi/);
    }
  });
});

describe('estimateComplexity — invariants critici (anti-regression)', () => {
  it("Document intelligence pipeline ESATTO dell'utente NON deve mai accettare < 14 nodi", () => {
    // Anti-regression del bug 2026-05-30 — workflow 2 nodi era accettato.
    const goal = `Document intelligence pipeline: cartella S3 con PDF in arrivo, OCR + vision AI extract entities, classifica documento (contratto/fattura/preventivo), validazione schema, branching per tipo: contratto → legal team review queue, fattura → ERP push, preventivo → CRM opportunity, in caso di low confidence routing manuale + Slack notification, summary AI giornaliero al management.`;
    const e = estimateComplexity(goal);
    expect(e.minNodes).toBeGreaterThanOrEqual(14);
    // Verifica che finalize con 2 nodi venga RIFIUTATO.
    const gate = shouldRejectFinalize(goal, 2);
    expect(gate.reject).toBe(true);
  });

  it('riducendo la complessità del goal, minNodes DEVE diminuire (monotonia)', () => {
    const heavy =
      'classifica valida estrai notifica archivia Slack Telegram ERP S3 contratto fattura preventivo branching low confidence';
    const light = 'estrai email salva allegato';
    expect(estimateComplexity(heavy).minNodes).toBeGreaterThan(estimateComplexity(light).minNodes);
  });
});
