import { describe, expect, it } from 'vitest';

import { messaggioEliminazione } from './elimina-workflow';

describe('la domanda prima di eliminare un workflow', () => {
  it('nomina il workflow: «questo» non dice quale', () => {
    const testo = messaggioEliminazione({ name: 'Fatture in scadenza', enabled: false });
    expect(testo).toContain('Fatture in scadenza');
  });

  it('🚨 dichiara che non si può tornare indietro', () => {
    const testo = messaggioEliminazione({ name: 'Qualcosa', enabled: false });
    expect(testo).toContain('Non si può annullare');
  });

  it('🚨 se il workflow è attivo, avvisa che le automazioni si fermano', () => {
    const testo = messaggioEliminazione({ name: 'Promemoria', enabled: true });
    expect(testo).toContain('È attivo');
    expect(testo).toContain('smetteranno di girare');
  });

  it('su un workflow spento non minaccia automazioni che non stanno girando', () => {
    const testo = messaggioEliminazione({ name: 'Bozza', enabled: false });
    expect(testo).not.toContain('È attivo');
  });

  it('un workflow senza nome resta comprensibile', () => {
    expect(messaggioEliminazione({ name: '   ', enabled: false })).toContain('questo workflow');
    expect(messaggioEliminazione(undefined)).toContain('questo workflow');
  });
});
