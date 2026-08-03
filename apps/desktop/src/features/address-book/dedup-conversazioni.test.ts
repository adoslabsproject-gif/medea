import { describe, expect, it } from 'vitest';

import {
  accorpaConversazioni,
  oggettoNormalizzato,
  somiglianza,
  type EmailAccorpabile,
} from './dedup-conversazioni';

function email(
  id: number,
  subject: string | null,
  internalDate: string | null,
  preview: string | null = null,
): EmailAccorpabile {
  return { id, subject, internalDate, preview };
}

describe('l’oggetto senza prefissi', () => {
  it('toglie Re:, R:, Fwd: e le loro combinazioni', () => {
    expect(oggettoNormalizzato('Re: Preventivo')).toBe('preventivo');
    expect(oggettoNormalizzato('R: Preventivo')).toBe('preventivo');
    expect(oggettoNormalizzato('Fwd: Preventivo')).toBe('preventivo');
  });

  it('🚨 li toglie tutti, non solo il primo: dopo tre scambi si accumulano', () => {
    expect(oggettoNormalizzato('R: Re: R: Fwd: Preventivo')).toBe('preventivo');
  });

  it('non tocca un oggetto che comincia per una parola simile a un prefisso', () => {
    expect(oggettoNormalizzato('Report mensile')).toBe('report mensile');
    expect(oggettoNormalizzato('Reso merce')).toBe('reso merce');
  });
});

describe('quanto due testi si somigliano', () => {
  it('due testi identici si somigliano del tutto', () => {
    expect(somiglianza('preventivo per la fornitura', 'preventivo per la fornitura')).toBe(1);
  });

  it('🚨 due testi senza niente in comune non si somigliano', () => {
    const s = somiglianza(
      'preventivo fornitura valvole industriali',
      'convocazione assemblea condominiale straordinaria',
    );
    expect(s).toBeLessThan(0.12);
  });

  it('le parole corte non contano: sono uguali in qualunque email', () => {
    // Solo articoli e preposizioni in comune: non è somiglianza.
    const s = somiglianza('il che di e la per un', 'il che di e la per un');
    expect(s).toBe(1); // nessuna parola significativa da nessuna parte → si accorpa
  });
});

describe('accorpare le conversazioni', () => {
  it('tiene la più recente e conta quante ne ha accorpate', () => {
    const gruppi = accorpaConversazioni([
      email(1, 'Preventivo', '2026-08-01T10:00:00Z', 'testo del preventivo fornitura'),
      email(2, 'Re: Preventivo', '2026-08-03T10:00:00Z', 'testo del preventivo fornitura rivisto'),
      email(3, 'R: Re: Preventivo', '2026-08-02T10:00:00Z', 'testo del preventivo fornitura'),
    ]);

    expect(gruppi).toHaveLength(1);
    expect(gruppi[0]!.ultima.id).toBe(2);
    expect(gruppi[0]!.quante).toBe(3);
  });

  it('🚨 oggetti uguali su contenuti totalmente diversi restano separati', () => {
    // «Fattura» è un oggetto che torna identico su cose che non c'entrano.
    const gruppi = accorpaConversazioni([
      email(1, 'Fattura', '2026-08-01T10:00:00Z', 'fattura numero 12 fornitura valvole idrauliche'),
      email(2, 'Fattura', '2026-08-02T10:00:00Z', 'sollecito pagamento canone locazione capannone'),
    ]);

    expect(gruppi).toHaveLength(2);
  });

  it('oggetti diversi non si toccano mai', () => {
    const gruppi = accorpaConversazioni([
      email(1, 'Preventivo', '2026-08-01T10:00:00Z', 'stesso testo qui'),
      email(2, 'Ordine', '2026-08-02T10:00:00Z', 'stesso testo qui'),
    ]);
    expect(gruppi).toHaveLength(2);
  });

  it('l’ordine in ingresso non conta', () => {
    const crescente = accorpaConversazioni([
      email(1, 'Tema', '2026-08-01T10:00:00Z', 'contenuto comune della conversazione'),
      email(2, 'Tema', '2026-08-05T10:00:00Z', 'contenuto comune della conversazione'),
    ]);
    const decrescente = accorpaConversazioni([
      email(2, 'Tema', '2026-08-05T10:00:00Z', 'contenuto comune della conversazione'),
      email(1, 'Tema', '2026-08-01T10:00:00Z', 'contenuto comune della conversazione'),
    ]);
    expect(crescente[0]!.ultima.id).toBe(2);
    expect(decrescente[0]!.ultima.id).toBe(2);
  });

  it('le email senza data finiscono in fondo e non spariscono', () => {
    const gruppi = accorpaConversazioni([
      email(1, 'Senza data', null, 'contenuto'),
      email(2, 'Con data', '2026-08-05T10:00:00Z', 'altro contenuto diverso'),
    ]);
    expect(gruppi).toHaveLength(2);
    expect(gruppi[gruppi.length - 1]!.ultima.id).toBe(1);
  });

  it('un elenco vuoto non produce niente', () => {
    expect(accorpaConversazioni([])).toEqual([]);
  });
});
