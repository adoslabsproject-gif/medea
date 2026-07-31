/**
 * Le regole che guardano i valori scritti nei campi e il senso complessivo
 * del flusso.
 *
 * Qui i falsi allarmi sono il rischio principale: `{{secrets.X}}` non è un
 * segnaposto, `apiKeyHeaderName` non è un segreto, un valore scelto dal menu
 * a tendina non è un'invenzione del modello. Ogni regola ha il suo caso
 * innocente accanto a quello colpevole.
 */

import { describe, expect, it } from 'vitest';

import { PICKER_PLACEHOLDER } from '../constants';

import { detectCodeLanguage } from './code-lang';
import { codes, edge, input, node } from './fixtures';
import {
  checkCodeNodeLangMismatch,
  checkObsoleteModel,
  checkSwitchInvalidCaseKey,
} from './rules-config';
import { checkDbColumnNotInSchema, checkDbTableNotInSchema } from './rules-db';
import {
  checkAuditNotTerminal,
  checkSensitiveHardcoded,
  checkTriggerWithoutAction,
} from './rules-intent';
import { checkMockPlaceholders, checkSuspiciousResourceIds } from './rules-placeholder';
import {
  checkErrorBranchInverted,
  checkErrorHandlerNoSink,
  checkLookupWithoutBranch,
} from './rules-semantic';

describe('valori inventati', () => {
  it('riconosce un host SMTP fittizio come problema critico', () => {
    const issues = checkMockPlaceholders(
      input([node('invia', 'action_send_email', { smtpHost: 'smtp.example.com' })]),
    );
    expect(issues[0]?.severity).toBe('critical');
  });

  it('tratta il destinatario segnaposto come semplice avviso', () => {
    const issues = checkMockPlaceholders(
      input([node('invia', 'action_send_email', { to: 'utente@acme.com' })]),
    );
    expect(issues[0]?.severity).toBe('medium');
  });

  it('non tocca le espressioni del motore', () => {
    const issues = checkMockPlaceholders(
      input([node('invia', 'action_send_email', { apiKey: '{{secrets.API_KEY}}' })]),
    );
    expect(issues).toEqual([]);
  });

  it('segnala un solo problema per campo', () => {
    const issues = checkMockPlaceholders(
      input([node('a', 'action_http', { url: 'https://api.example.com/your-api-key' })]),
    );
    expect(issues).toHaveLength(1);
  });
});

describe('identificativi di risorse', () => {
  it('segnala un id che non assomiglia a un id', () => {
    const issues = checkSuspiciousResourceIds(
      input([node('q', 'db_query', { databaseId: 'db_opportunities' })]),
    );
    expect(codes(issues)).toEqual(['SUSPICIOUS_RESOURCE_ID']);
  });

  it('accetta un UUID', () => {
    const issues = checkSuspiciousResourceIds(
      input([node('q', 'db_query', { databaseId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })]),
    );
    expect(issues).toEqual([]);
  });

  it('lascia stare il campo che l’utente sceglierà dal menu', () => {
    const issues = checkSuspiciousResourceIds(
      input([node('q', 'db_query', { databaseId: PICKER_PLACEHOLDER })]),
    );
    expect(issues).toEqual([]);
  });
});

describe('configurazione dei nodi', () => {
  it('segnala i casi dello switch scritti come condizioni', () => {
    const issues = checkSwitchInvalidCaseKey(
      input([node('scelta', 'logic_switch', { cases: { 'score < 90': 'basso', alto: 'alto' } })]),
    );
    expect(issues[0]?.message).toContain('score < 90');
  });

  it('accetta i casi scritti come etichette', () => {
    const issues = checkSwitchInvalidCaseKey(
      input([node('scelta', 'logic_switch', { cases: { fattura: 'a', ordine: 'b' } })]),
    );
    expect(issues).toEqual([]);
  });

  it('riconosce il Python dentro un nodo JavaScript', () => {
    expect(detectCodeLanguage('import json\nprint(json.loads(x))')).toBe('python');
    const issues = checkCodeNodeLangMismatch(
      input([node('esegui', 'action_run_js', { code: 'import json\nprint(json.loads(x))' })]),
    );
    expect(codes(issues)).toEqual(['CODE_NODE_LANG_MISMATCH']);
  });

  it('non si pronuncia su codice che potrebbe essere di entrambi', () => {
    const issues = checkCodeNodeLangMismatch(
      input([node('esegui', 'action_run_js', { code: 'x = 1' })]),
    );
    expect(issues).toEqual([]);
  });

  it('segnala un modello ritirato dal fornitore', () => {
    const issues = checkObsoleteModel(
      input([node('ai', 'agent_classifier', { provider: 'anthropic', model: 'claude-2.1' })]),
    );
    expect(issues[0]?.severity).toBe('medium');
  });
});

describe('riferimenti al database', () => {
  const catalogo = [{ id: 'db1', tables: ['clienti'], columns: { clienti: ['id', 'nome'] } }];

  it('segnala una tabella che non esiste', () => {
    const issues = checkDbTableNotInSchema(
      input([node('q', 'db_query', { databaseId: 'db1', table: 'fornitori' })], [], catalogo),
    );
    expect(issues[0]?.message).toContain('"clienti"');
  });

  it('segnala una colonna che non esiste', () => {
    const issues = checkDbColumnNotInSchema(
      input(
        [
          node('ins', 'db_insert', {
            databaseId: 'db1',
            table: 'clienti',
            rowJson: '{"nome":"x","codice":"y"}',
          }),
        ],
        [],
        catalogo,
      ),
    );
    expect(issues[0]?.message).toContain('"codice"');
  });

  it('tace quando il catalogo non è disponibile', () => {
    const senzaCatalogo = input([
      node('q', 'db_query', { databaseId: 'db1', table: 'inesistente' }),
    ]);
    expect(checkDbTableNotInSchema(senzaCatalogo)).toEqual([]);
  });
});

describe('logica del flusso', () => {
  it('riconosce i rami di errore invertiti', () => {
    const issues = checkErrorBranchInverted(
      input(
        [
          node('controllo', 'logic_if', { condition: 'status >= 500' }),
          node('scarti', 'db_insert', { table: 'dlq' }),
          node('prosegui', 'action_http', { url: 'https://reale.it' }),
        ],
        [edge('controllo', 'scarti', 'false'), edge('controllo', 'prosegui', 'true')],
      ),
    );
    expect(codes(issues)).toEqual(['ERROR_BRANCH_INVERTED']);
  });

  it('non segnala i rami nel verso giusto', () => {
    const issues = checkErrorBranchInverted(
      input(
        [
          node('controllo', 'logic_if', { condition: 'status >= 500' }),
          node('scarti', 'db_insert', { table: 'dlq' }),
          node('prosegui', 'action_http', { url: 'https://reale.it' }),
        ],
        [edge('controllo', 'scarti', 'true'), edge('controllo', 'prosegui', 'false')],
      ),
    );
    expect(issues).toEqual([]);
  });

  it('segnala l’errore che non arriva da nessuna parte', () => {
    const issues = checkErrorHandlerNoSink(
      input(
        [
          node('controllo', 'logic_if', { condition: 'response.error' }),
          node('prosegui', 'action_http', { url: 'https://reale.it' }),
        ],
        [edge('controllo', 'prosegui', 'true')],
      ),
    );
    expect(codes(issues)).toEqual(['ERROR_HANDLER_NO_SINK']);
  });

  it('segnala il "cerca" collegato dritto al "crea"', () => {
    const issues = checkLookupWithoutBranch(
      input(
        [
          node('cerca', 'action_http', { method: 'GET', url: 'https://crm.reale.it/contact' }),
          node('crea', 'db_insert', { table: 'contatti' }),
        ],
        [edge('cerca', 'crea')],
      ),
    );
    expect(codes(issues)).toEqual(['LOOKUP_WITHOUT_BRANCH']);
  });
});

describe('intenzione complessiva', () => {
  it('segnala il workflow che parte e non fa niente', () => {
    const issues = checkTriggerWithoutAction(
      input([node('avvio', 'trigger_cron'), node('scelta', 'logic_if')]),
    );
    expect(codes(issues)).toEqual(['TRIGGER_WITHOUT_ACTION']);
  });

  it('segnala l’audit messo troppo presto', () => {
    const issues = checkAuditNotTerminal(
      input(
        [
          node('registra', 'db_insert', { table: 'audit_eventi' }),
          node('invia', 'action_send_email', { to: 'io@reale.it' }),
        ],
        [edge('registra', 'invia')],
      ),
    );
    expect(issues[0]?.severity).toBe('info');
  });

  it('segnala un segreto scritto in chiaro', () => {
    const issues = checkSensitiveHardcoded(
      input([node('a', 'action_http', { apiKey: 'sk-live-4d9f2b7c1e' })]),
    );
    expect(codes(issues)).toEqual(['SENSITIVE_HARDCODED']);
  });

  it('non scambia il nome di un header per un segreto', () => {
    const issues = checkSensitiveHardcoded(
      input([node('a', 'action_http', { apiKeyHeaderName: 'X-Api-Key' })]),
    );
    expect(issues).toEqual([]);
  });

  it('accetta il segreto passato come espressione', () => {
    const issues = checkSensitiveHardcoded(
      input([node('a', 'action_http', { password: '{{secrets.SMTP_PASSWORD}}' })]),
    );
    expect(issues).toEqual([]);
  });
});
