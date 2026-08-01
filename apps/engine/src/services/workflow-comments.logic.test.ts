import { describe, it, expect } from 'vitest';
import { parseMentions } from './workflow-comments.logic.js';

describe('parseMentions', () => {
  it('estrae @handle a inizio e dopo spazio', () => {
    expect(parseMentions('@marco guarda qui')).toEqual(['marco']);
    expect(parseMentions('ehi @ada e @marco')).toEqual(['ada', 'marco']);
  });
  it('handle con . _ -', () => {
    expect(parseMentions('@marco.rossi e @ada_b e @x-1')).toEqual(['marco.rossi', 'ada_b', 'x-1']);
  });
  it('dedup mantenendo l\'ordine', () => {
    expect(parseMentions('@ada @marco @ada')).toEqual(['ada', 'marco']);
  });
  it('NON matcha le email nel mezzo (a@b.it)', () => {
    expect(parseMentions('scrivi a marco@zeli.it grazie')).toEqual([]);
  });
  it('nessuna mention → array vuoto', () => {
    expect(parseMentions('commento senza menzioni')).toEqual([]);
    expect(parseMentions('')).toEqual([]);
  });
});
