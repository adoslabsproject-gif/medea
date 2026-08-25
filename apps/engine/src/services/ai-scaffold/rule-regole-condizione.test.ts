/**
 * Una condizione che non verrà mai valutata.
 *
 * Il 2026-08-15, «Monitoraggio prezzo prodotto»:
 *
 *     [{"field":"prezzo","op":"<","value":"{{prezzo_precedente}}"}]
 *
 * Quattro errori in una riga. `parseRuleset` vuole un oggetto con `rules`, non
 * un array nudo; il campo è `left`, non `field`; il confronto è `right`, non
 * `value`; l'operatore è `lt`, non `<`.
 *
 * Fallito il parsing, `logic_if` ripiega sul vecchio campo `condition` — qui
 * assente — e la condizione vale FALSO. Il workflow sarebbe partito ogni
 * mattina, per sempre, senza mai mandare l'avviso. Nessun errore, nessun
 * segnale: un'automazione ridotta a un rituale a vuoto.
 *
 * @module services/ai-scaffold/rule-regole-condizione.test
 */

import { describe, expect, it } from 'vitest';

import { runQualityGate } from '@/services/ai-scaffold/quality-gate.js';
import { checkRegoleCondizione } from '@/services/ai-scaffold/rule-regole-condizione.js';

const con = (conditionRules: unknown) => ({
  nodes: [
    { id: 'cron', defId: 'trigger_cron', config: {} },
    { id: 'confronta', defId: 'logic_if', config: { conditionRules } },
  ],
  edges: [{ from: 'cron', to: 'confronta' }],
});

describe('il caso vero', () => {
  const rotto = '[{"field":"prezzo","op":"<","value":"{{prezzo_precedente}}"}]';

  it('lo prende, ed è critico', () => {
    const issues = checkRegoleCondizione(con(rotto));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('critical');
    expect(issues[0]?.nodeId).toBe('confronta');
  });

  it('spiega che il ramo non partirebbe mai', () => {
    expect(checkRegoleCondizione(con(rotto))[0]?.message).toContain('vale FALSO');
  });

  it('dice che serve un oggetto, non un array', () => {
    expect(checkRegoleCondizione(con(rotto))[0]?.message).toContain('array nudo');
  });

  it('il gate lo rifiuta, così il modello rigenera', () => {
    const esito = runQualityGate(con(rotto));
    expect(esito.ok).toBe(false);
    expect(esito.issues.some((i) => i.code === 'REGOLE_CONDIZIONE_MALFORMATE')).toBe(true);
  });
});

describe('nomina gli sbagli per nome', () => {
  it('dice che ha scritto `field` invece di `left`', () => {
    const issues = checkRegoleCondizione(
      con('{"combinator":"AND","rules":[{"field":"x","op":"eq","right":"1"}]}'),
    );
    expect(issues[0]?.message).toContain('hai scritto `field`');
  });

  it('dice che il confronto si chiama `right`', () => {
    const issues = checkRegoleCondizione(
      con('{"combinator":"AND","rules":[{"left":"x","op":"<","value":"1"}]}'),
    );
    expect(issues[0]?.message).toContain('si chiama `right`');
  });

  it('segnala un operatore che non esiste', () => {
    const issues = checkRegoleCondizione(
      con('{"combinator":"AND","rules":[{"left":"x","op":">=","right":"1"}]}'),
    );
    expect(issues[0]?.message).toContain('non esiste');
  });
});

describe('quello che deve lasciar passare', () => {
  it('una condizione scritta bene', () => {
    expect(
      checkRegoleCondizione(
        con(
          '{"combinator":"AND","rules":[{"left":"{{$node.a.json.prezzo}}",' +
            '"op":"lt","right":"100","type":"number"}]}',
        ),
      ),
    ).toEqual([]);
  });

  /**
   * Il campo vuoto è legittimo: il vecchio `condition` a testo libero esiste
   * ancora, e un `logic_if` può usarlo.
   */
  it('un campo vuoto o assente', () => {
    expect(checkRegoleCondizione(con(''))).toEqual([]);
    expect(checkRegoleCondizione(con(undefined))).toEqual([]);
  });

  it('non tocca i nodi che non valutano regole', () => {
    expect(
      checkRegoleCondizione({
        nodes: [{ id: 'x', defId: 'action_http', config: { conditionRules: '[{"rotto":1}]' } }],
        edges: [],
      }),
    ).toEqual([]);
  });
});

/**
 * La causa vera: l'esempio nel prompt era sbagliato.
 *
 * Diceva `conditionRules: [{column:"score",op:"<",value:90}]` — array nudo,
 * `column`/`value`, operatore a simbolo. Il modello ha copiato quello che gli
 * avevamo insegnato, e il difetto era nostro.
 */
describe('il prompt insegna la forma giusta', () => {
  it('non mostra più l’array nudo con column/value', async () => {
    const { SINGLESHOT_SYSTEM_PROMPT } = await import('@/services/ai-scaffold/prompt.js');
    expect(SINGLESHOT_SYSTEM_PROMPT).not.toContain('[{column:"score"');
  });

  it('mostra l’oggetto con combinator e rules', async () => {
    const { SINGLESHOT_SYSTEM_PROMPT } = await import('@/services/ai-scaffold/prompt.js');
    expect(SINGLESHOT_SYSTEM_PROMPT).toContain('"combinator":"AND","rules"');
    expect(SINGLESHOT_SYSTEM_PROMPT).toContain('"left"');
  });

  it('dice che gli operatori sono nomi e non simboli', async () => {
    const { SINGLESHOT_SYSTEM_PROMPT } = await import('@/services/ai-scaffold/prompt.js');
    expect(SINGLESHOT_SYSTEM_PROMPT).toContain('operatori sono NOMI, mai simboli');
  });
});
