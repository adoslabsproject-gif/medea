/**
 * Test REALI per abort-gate. Ogni assert verifica behavior con valori
 * specifici — niente smoke "defined/truthy".
 *
 * Scenario centrale: il bug 2026-05-30 dove l'agente ha abortito dicendo
 * "Necessario nodo Telegram non disponibile. Installare community_telegram
 * o abilitare http_request per notifiche Telegram." MA community_telegram
 * era effettivamente installato.
 */

import { describe, it, expect } from 'vitest';
import { evaluateAbort } from './abort-gate.js';

const INSTALLED = [
  'community_telegram', 'community_slack', 'community_github',
  'action_http', 'action_send_email', 'action_file_write',
  'trigger_imap', 'trigger_webhook', 'trigger_cron',
  'agent_classifier', 'agent_extractor', 'agent_summarizer',
  'logic_if', 'logic_switch', 'db_query', 'db_insert',
];

describe('evaluateAbort — hallucinated defId rejection', () => {
  it('BUG 2026-05-30 esatto: "community_telegram non disponibile" mentre IS in catalog → REJECT', () => {
    const r = evaluateAbort({
      reason: 'Necessario nodo Telegram non disponibile. Installare community_telegram o abilitare http_request per notifiche Telegram.',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.hallucinatedDefIds).toContain('community_telegram');
      expect(r.replyToAgent).toContain('community_telegram');
      expect(r.replyToAgent).toContain('list_node_catalog');
    }
  });

  it('Reason cita action_http come non disponibile MENTRE IS in catalog → REJECT', () => {
    const r = evaluateAbort({
      reason: 'action_http non è installato per fare la chiamata REST',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.hallucinatedDefIds).toContain('action_http');
    }
  });

  it('Reason cita defId NON in catalog (genuine missing) → REJECT comunque per REGOLA 12', () => {
    // Anche se community_signal non c'è davvero, REGOLA 12 vieta abort per
    // "nodo non installato" — l'agente deve fallback con action_http.
    const r = evaluateAbort({
      reason: 'community_signal_messenger non è disponibile e non posso procedere',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
    if (r.reject) {
      // Non è hallucinated (il defId non esiste), ma è comunque rejected
      // per la regola "MAI abort per nodo non installato".
      expect(r.replyToAgent).toContain('REGOLA 12');
      expect(r.replyToAgent).toContain('action_http');
    }
  });

  it('Reason genuino (goal impossibile) → ACCEPT', () => {
    // Es. goal "manda un drone fisico per consegnare la pizza" — nessun
    // workflow lo può fare. Abort legittimo.
    const r = evaluateAbort({
      reason: 'Il goal richiede attuazione fisica nel mondo reale (consegna fisica drone). Nessun workflow software può risolverlo.',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(false);
  });

  it('Reason vuoto → ACCEPT (caso edge)', () => {
    const r = evaluateAbort({ reason: '', installedDefIds: INSTALLED });
    expect(r.reject).toBe(false);
  });

  it('Reason case-insensitive: COMMUNITY_TELEGRAM uppercase nel reason → match comunque', () => {
    const r = evaluateAbort({
      reason: 'COMMUNITY_TELEGRAM non disponibile',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
  });

  it('Hallucinati MULTIPLI nel reason → tutti listati nella response', () => {
    const r = evaluateAbort({
      reason: 'community_telegram, community_slack e action_http tutti mancanti, non posso continuare',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.hallucinatedDefIds.sort()).toEqual(
        ['action_http', 'community_slack', 'community_telegram'],
      );
    }
  });
});

describe('evaluateAbort — REGOLA 12 patterns (no defId-citation)', () => {
  it('"nodo Telegram mancante" senza citare defId → REJECT per pattern', () => {
    const r = evaluateAbort({
      reason: 'Nodo Telegram mancante, impossibile continuare con notifiche',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
    if (r.reject) {
      expect(r.replyToAgent).toContain('REGOLA 12');
      expect(r.replyToAgent).toContain('action_http');
    }
  });

  it('"not installed in the catalog" (EN) → REJECT', () => {
    const r = evaluateAbort({
      reason: 'Slack node is not installed in the catalog for this tenant.',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
  });

  it('"missing node for X" → REJECT', () => {
    const r = evaluateAbort({
      reason: 'Missing node for sending push notification',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(true);
  });

  it('reason esistenziale legittima ("impossibile risolvere") → ACCEPT (no pattern match)', () => {
    const r = evaluateAbort({
      reason: 'Il goal richiede coscienza umana per giudicare l\'arte. Fuori dallo scope.',
      installedDefIds: INSTALLED,
    });
    expect(r.reject).toBe(false);
  });
});
