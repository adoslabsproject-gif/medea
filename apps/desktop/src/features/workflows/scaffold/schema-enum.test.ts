/**
 * I defId ammessi devono stare nello schema, non solo nel prompt.
 *
 * Il 2026-08-04, chiedendo di archiviare una fattura, il modello ha prodotto
 * `trigger_email`, `action_extract_fattura` e `action_add_to_table`: tre nomi
 * plausibili e inesistenti, mentre `trigger_imap`, `db_insert` e
 * `action_send_email` erano nell'elenco che aveva davanti. Descrivere quali
 * nodi esistono è un suggerimento, e un suggerimento si può ignorare; un enum
 * nello schema no, perché lo fa rispettare il server token per token.
 *
 * @module features/workflows/scaffold/schema-enum.test
 */

import { describe, expect, it } from 'vitest';

import { schemaConDefIdAmmessi, SINGLESHOT_OUTPUT_SCHEMA } from './schema';

interface FormaSchema {
  properties?: {
    nodes?: { items?: { properties?: { defId?: { enum?: string[] } } } };
  };
}

function enumDi(schema: Record<string, unknown> | object): string[] | undefined {
  return (schema as FormaSchema).properties?.nodes?.items?.properties?.defId?.enum;
}

describe('lo schema che vincola i defId', () => {
  it('🚨 elenca esattamente i nodi ammessi', () => {
    const schema = schemaConDefIdAmmessi(['trigger_cron', 'db_insert']);
    expect(enumDi(schema)).toEqual(['trigger_cron', 'db_insert']);
  });

  it('🚨 senza enum il modello può scrivere qualunque nome, ed è quello che faceva', () => {
    // La prova che il vincolo serve: nello schema di partenza defId è una
    // stringa libera, e «action_extract_fattura» è una stringa.
    expect(enumDi(SINGLESHOT_OUTPUT_SCHEMA)).toBeUndefined();
  });

  it('non intacca lo schema di partenza: due chiamate non si sporcano a vicenda', () => {
    schemaConDefIdAmmessi(['solo_questo']);
    expect(enumDi(SINGLESHOT_OUTPUT_SCHEMA)).toBeUndefined();
    expect(enumDi(schemaConDefIdAmmessi(['altro']))).toEqual(['altro']);
  });

  it('senza nodi da vincolare resta libero invece di non ammettere nulla', () => {
    // Un enum vuoto sarebbe una grammatica che non accetta nessun defId: il
    // modello non potrebbe produrre un workflow valido nemmeno volendo.
    expect(enumDi(schemaConDefIdAmmessi([]))).toBeUndefined();
  });

  it('il resto dello schema resta quello di prima', () => {
    const schema = schemaConDefIdAmmessi(['trigger_cron']);
    expect(schema.required).toEqual(['name', 'reasoning', 'nodes', 'edges']);
    expect(schema.additionalProperties).toBe(false);
  });
});
