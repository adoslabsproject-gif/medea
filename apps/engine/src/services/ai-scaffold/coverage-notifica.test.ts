/**
 * «Dimmi» è una capacità, non un modo di dire.
 *
 * Chiesto due volte in questa sessione e disatteso due volte: il workflow
 * componeva il messaggio con un `action_text` e poi non lo consegnava a
 * nessuno. Il flusso finiva in silenzio — nessun errore, nessuna email, e chi
 * aspettava una risposta non riceveva niente.
 *
 * Comporre non è avvisare.
 *
 * @module services/ai-scaffold/coverage-notifica.test
 */

import { describe, expect, it } from 'vitest';

import { extractMissingCapabilities } from '@/services/ai-scaffold/requirement-coverage.js';

const manca = (prompt: string, nodi: string[]): string[] =>
  extractMissingCapabilities(prompt, nodi).map((m) => m.id);

describe('il caso vero', () => {
  it('«dimmi quante ne hai tolte» con un solo action_text non basta', () => {
    expect(
      manca('Ogni mese cancella le righe vecchie e dimmi quante ne hai tolte.', [
        'trigger_cron',
        'db_delete',
        'action_text',
      ]),
    ).toContain('notifica');
  });

  it('con un nodo che consegna davvero, tace', () => {
    expect(
      manca('Ogni mese cancella le righe vecchie e dimmi quante ne hai tolte.', [
        'trigger_cron',
        'db_delete',
        'action_text',
        'action_send_email',
      ]),
    ).not.toContain('notifica');
  });

  it('vale anche per gli altri canali', () => {
    for (const canale of ['community_slack', 'community_telegram', 'action_whatsapp_send']) {
      expect(manca('avvisami quando arriva', ['trigger_imap', canale])).not.toContain('notifica');
    }
  });
});

describe('quello che non deve far scattare', () => {
  /**
   * I termini sono all'imperativo e rivolti a chi scrive. «Notifica» come
   * sostantivo compare in mille contesti e chiederebbe un canale dove non
   * serve.
   */
  it('non scatta su un obiettivo che non chiede di essere avvisato', () => {
    expect(manca('Ogni mese cancella le righe più vecchie di novanta giorni.', [
      'trigger_cron',
      'db_delete',
    ])).not.toContain('notifica');
  });

  it('non scatta sulla parola «notifica» usata come sostantivo', () => {
    expect(
      manca('Archivia le notifiche di sistema nella tabella log.', ['trigger_imap', 'db_insert']),
    ).not.toContain('notifica');
  });
});
