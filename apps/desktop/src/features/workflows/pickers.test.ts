import { describe, expect, it } from 'vitest';

import { pickerKind } from './pickers';

describe('quale elenco serve a quale campo', () => {
  it('riconosce i campi che scelgono un database', () => {
    expect(pickerKind('db-picker')).toBe('database');
  });

  it('tratta tabelle e collezioni allo stesso modo', () => {
    // Sono la stessa domanda posta a motori diversi: «dentro quale contenitore».
    expect(pickerKind('db-table-picker')).toBe('table');
    expect(pickerKind('db-collection-picker')).toBe('table');
  });

  it('riconosce gli account di posta, comunque si chiamino', () => {
    expect(pickerKind('account-picker')).toBe('account');
    expect(pickerKind('email-account-picker')).toBe('account');
  });

  it('manda i campi credenziali sui segreti', () => {
    // Il valore non si mostra mai: si sceglie il NOME, e nel documento
    // finisce il riferimento.
    expect(pickerKind('credential-picker')).toBe('secret');
  });

  it('non inventa un elenco per i campi che non lo hanno', () => {
    expect(pickerKind('text')).toBeNull();
    expect(pickerKind('file-picker')).toBeNull();
  });
});
