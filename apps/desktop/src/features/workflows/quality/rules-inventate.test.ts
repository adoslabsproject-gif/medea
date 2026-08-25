/**
 * Le due regole nate dai workflow che il wizard ha prodotto il 2026-08-05.
 *
 * Erano entrambi validi per forma — nodi collegati, campi obbligatori pieni,
 * gate quasi verde — e nessuno dei due funzionava. Questi test descrivono
 * esattamente ciò che li rendeva finti, così non possono tornare in silenzio.
 */

import { describe, expect, it } from 'vitest';

import { checkDatiInventati, sembraUnElencoDiDati } from './rules-dati-inventati';
import { checkEspressioniNonRisolvibili } from './rules-espressioni';
import type { QualityGateInput } from './types';

function input(
  nodes: { id: string; defId: string; config: Record<string, unknown> }[],
  edges: { from: string; to: string }[] = [],
): QualityGateInput {
  return {
    nodes: nodes.map((n) => ({ ...n, x: 0, y: 0 })),
    edges,
  };
}

describe('sembraUnElencoDiDati', () => {
  /** Il valore esatto uscito dal wizard, con l'intestazione davanti. */
  it('riconosce l’elenco di date che ha ingannato il gate', () => {
    expect(
      sembraUnElencoDiDati('Newsletter archiviate:\n- 2026-07-13\n- 2026-07-20\n- 2026-07-27'),
    ).toBe(true);
  });

  it('riconosce elenchi di indirizzi e di numeri', () => {
    expect(sembraUnElencoDiDati('a@x.it\nb@x.it\nc@x.it')).toBe(true);
    expect(sembraUnElencoDiDati('10\n20\n30\n40')).toBe(true);
  });

  /** La prosa non deve mai combaciare: un corpo di email è testo, non dati. */
  it('lascia stare il testo libero', () => {
    expect(
      sembraUnElencoDiDati('Ciao,\nti mando il riepilogo di questa settimana.\nA presto,\nMario'),
    ).toBe(false);
  });

  it('non si scomoda per due righe: serve un elenco, non una coppia', () => {
    expect(sembraUnElencoDiDati('2026-07-13\n2026-07-20')).toBe(false);
  });
});

describe('checkDatiInventati', () => {
  const ELENCO = '- 2026-07-13\n- 2026-07-20\n- 2026-07-27';

  it('segnala l’elenco scritto a mano in un nodo che ha qualcuno prima', () => {
    const issues = checkDatiInventati(
      input(
        [
          { id: 'quando', defId: 'trigger_cron', config: {} },
          { id: 'scrivi', defId: 'action_file_write', config: { content: ELENCO } },
        ],
        [{ from: 'quando', to: 'scrivi' }],
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('DATI_INVENTATI');
    expect(issues[0]?.severity).toBe('critical');
    expect(issues[0]?.nodeId).toBe('scrivi');
  });

  /**
   * Nel primo nodo lo stesso elenco è configurazione legittima: una lista di
   * destinatari, dei codici da cercare. Il vincolo «ha un predecessore» è ciò
   * che tiene la regola sicura.
   */
  it('lascia stare lo stesso elenco nel primo nodo', () => {
    const issues = checkDatiInventati(
      input([{ id: 'primo', defId: 'action_file_write', config: { content: ELENCO } }]),
    );
    expect(issues).toEqual([]);
  });

  it('tace se il valore legge da un altro nodo', () => {
    const issues = checkDatiInventati(
      input(
        [
          { id: 'quando', defId: 'trigger_cron', config: {} },
          {
            id: 'scrivi',
            defId: 'action_file_write',
            config: { content: '{{$node.quando.json.righe}}' },
          },
        ],
        [{ from: 'quando', to: 'scrivi' }],
      ),
    );
    expect(issues).toEqual([]);
  });
});

describe('checkEspressioniNonRisolvibili', () => {
  /** Il caso vero: nomina un nodo che esiste, ma senza `$node.`. */
  it('segnala il riferimento senza prefisso, e dice come si scrive', () => {
    const issues = checkEspressioniNonRisolvibili(
      input(
        [
          { id: 'trigger_email', defId: 'trigger_imap', config: {} },
          {
            id: 'salva',
            defId: 'action_file_write',
            config: { path: '/tmp/{{trigger_email.email.id}}.pdf' },
          },
        ],
        [{ from: 'trigger_email', to: 'salva' }],
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('ESPRESSIONE_NON_RISOLVIBILE');
    expect(issues[0]?.message).toContain('{{$node.trigger_email.json.<campo>}}');
  });

  it('segnala chi legge da un nodo che non esiste', () => {
    const issues = checkEspressioniNonRisolvibili(
      input([{ id: 'solo', defId: 'action_http', config: { url: '{{$node.fantasma.json.url}}' } }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('fantasma');
  });

  it('segnala chi legge da sé stesso', () => {
    const issues = checkEspressioniNonRisolvibili(
      input([{ id: 'io', defId: 'action_http', config: { url: '{{$node.io.json.url}}' } }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('non esiste ancora');
  });

  it('accetta il riferimento scritto bene', () => {
    const issues = checkEspressioniNonRisolvibili(
      input(
        [
          { id: 'trigger_email', defId: 'trigger_imap', config: {} },
          {
            id: 'salva',
            defId: 'action_file_write',
            config: { path: '/tmp/{{$node.trigger_email.json.uid}}.pdf' },
          },
        ],
        [{ from: 'trigger_email', to: 'salva' }],
      ),
    );
    expect(issues).toEqual([]);
  });

  /**
   * Questo non è un interprete: espressioni che non nominano un nodo si
   * lasciano passare. Meglio tacere che segnalare un falso allarme su una
   * funzione di libreria che non conosciamo.
   */
  it('non si intromette nelle espressioni che non nominano nodi', () => {
    const issues = checkEspressioniNonRisolvibili(
      input([
        {
          id: 'solo',
          defId: 'action_template',
          config: { testo: '{{ now() }} — {{ item.nome }}' },
        },
      ]),
    );
    expect(issues).toEqual([]);
  });
});

describe('checkEspressioniNonRisolvibili — la graffa singola', () => {
  /**
   * Il caso vero del 2026-08-05, passato *attraverso* la regola scritta per
   * fermarlo: una graffa sola, e dentro JavaScript.
   */
  it('vede il riferimento con una graffa sola', () => {
    const issues = checkEspressioniNonRisolvibili(
      input([
        {
          id: 'invia',
          defId: 'action_send_email',
          config: {
            body: '<ul>{$node.cerca.json.rows.map(r => `<li>${r.subject}</li>`)}</ul>',
          },
        },
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('ESPRESSIONE_NON_RISOLVIBILE');
    expect(issues[0]?.message).toContain('graffa sola');
  });

  /** Le doppie scritte bene non devono essere scambiate per singole. */
  it('non scambia le doppie per singole', () => {
    const issues = checkEspressioniNonRisolvibili(
      input([
        { id: 'a', defId: 'trigger_cron', config: {} },
        { id: 'b', defId: 'action_http', config: { url: '{{$node.a.json.url}}' } },
      ]),
    );
    expect(issues).toEqual([]);
  });

  /** Una graffa che non nomina un nodo è testo, e resta testo: CSS, JSON, prosa. */
  it('lascia stare le graffe che non nominano nodi', () => {
    const issues = checkEspressioniNonRisolvibili(
      input([{ id: 'x', defId: 'action_template', config: { css: 'body { color: red }' } }]),
    );
    expect(issues).toEqual([]);
  });
});
