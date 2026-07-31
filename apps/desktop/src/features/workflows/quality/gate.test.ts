/**
 * Il verdetto complessivo: cosa passa, cosa viene respinto, in che ordine
 * arrivano i problemi.
 *
 * Il criterio è quello che l'utente vive: premuto «Importa», il workflow deve
 * funzionare. Un falso allarme su un workflow sano è grave quanto un problema
 * vero lasciato passare — il primo fa perdere fiducia nel controllo, il
 * secondo nel prodotto.
 */

import { describe, expect, it } from 'vitest';

import { codes, edge, healthyWorkflow, input, node } from './fixtures';
import { describeIssues, gateWorkflow, QUALITY_RULES, runQualityGate } from './gate';

describe('regole registrate', () => {
  it('sono le 21 previste, senza doppioni', () => {
    expect(QUALITY_RULES).toHaveLength(21);
    expect(new Set(QUALITY_RULES.map((r) => r.code)).size).toBe(21);
  });
});

describe('verdetto', () => {
  it('lascia passare un workflow sano senza segnalare nulla', () => {
    const res = runQualityGate(healthyWorkflow());
    expect(res.ok).toBe(true);
    expect(res.shouldReject).toBe(false);
    expect(res.issues).toEqual([]);
  });

  it('respinge il workflow appena un problema è critico', () => {
    const res = runQualityGate(input([node('avvio', 'trigger_cron', { cron: '0 9 * * *' })]));
    expect(res.shouldReject).toBe(true);
    expect(res.ok).toBe(false);
    expect(codes(res.issues)).toContain('ORPHAN_TRIGGER');
  });

  it('non respinge per i soli avvisi', () => {
    const res = runQualityGate(
      input(
        [
          node('avvio', 'trigger_cron', { cron: '0 9 * * *' }),
          node('scelta', 'logic_switch', { cases: { a: 'x', b: 'y' } }),
          node('invia', 'action_send_email', { to: 'io@aziendareale.it', subject: 'Ok' }),
        ],
        [edge('avvio', 'scelta'), edge('scelta', 'invia')],
      ),
    );
    expect(codes(res.issues)).toContain('SWITCH_NO_DEFAULT');
    expect(res.shouldReject).toBe(false);
    expect(res.ok).toBe(true);
  });
});

describe('ordinamento', () => {
  it('mette i problemi critici prima degli avvisi', () => {
    const res = runQualityGate(
      input(
        [
          node('avvio', 'trigger_cron', { cron: '0 9 * * *' }),
          node('scelta', 'logic_switch', { cases: { a: 'x' } }),
          node('chiama', 'action_http', { url: 'https://api.example.com/dati' }),
        ],
        [edge('avvio', 'scelta'), edge('scelta', 'chiama')],
      ),
    );
    const severities = res.issues.map((i) => i.severity);
    expect(severities.indexOf('critical')).toBeLessThan(severities.lastIndexOf('medium'));
  });

  it('produce sempre lo stesso elenco per lo stesso workflow', () => {
    const wf = input(
      [
        node('avvio', 'trigger_cron', { cron: '0 9 * * *' }),
        node('b', 'action_http', { url: 'https://example.com' }),
        node('a', 'action_http', { url: 'https://example.org' }),
      ],
      [edge('avvio', 'b'), edge('avvio', 'a')],
    );
    expect(codes(runQualityGate(wf).issues)).toEqual(codes(runQualityGate(wf).issues));
    expect(runQualityGate(wf).issues.map((i) => i.nodeId)).toEqual(['a', 'b']);
  });
});

describe('adattatore per il workflow completo', () => {
  it('accetta i nodi del canvas ignorando posizione ed etichette', () => {
    const res = gateWorkflow({
      nodes: [
        { id: 'avvio', defId: 'trigger_cron', x: 0, y: 0, config: { cron: '0 9 * * *' } },
        {
          id: 'invia',
          defId: 'action_send_email',
          x: 220,
          y: 0,
          config: { to: 'io@aziendareale.it', subject: 'Ciao' },
          label: 'Notifica',
        },
      ],
      edges: [{ from: 'avvio', to: 'invia' }],
    });
    expect(res.ok).toBe(true);
  });
});

describe('resoconto per il modello', () => {
  it('indica gravità, codice, nodo e campo', () => {
    const res = runQualityGate(
      input([
        node('avvio', 'trigger_cron', { cron: '0 9 * * *' }),
        node('invia', 'action_send_email', {
          smtpHost: 'smtp.example.com',
          to: 'io@aziendareale.it',
        }),
      ]),
    );
    const righe = describeIssues(res.issues);
    expect(righe.some((r) => r.startsWith('CRITICAL MOCK_PLACEHOLDER [nodo invia.smtpHost]'))).toBe(
      true,
    );
  });
});
