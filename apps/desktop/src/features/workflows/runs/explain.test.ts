import { describe, expect, it } from 'vitest';

import { buildPrompt, ripulisci } from './explain';

describe('cosa arriva al modello', () => {
  it('i valori delle credenziali non escono da qui', () => {
    // Mandare a un servizio esterno la password SMTP di qualcuno perché
    // spieghi un timeout sarebbe sproporzionato.
    const pulita = ripulisci({ host: 'smtp.aruba.it', password: 'vera', apiKey: 'k-123' });
    expect(pulita.password).toBe('«nascosto»');
    expect(pulita.apiKey).toBe('«nascosto»');
  });

  it('ma i NOMI dei campi restano: servono a capire com’era fatto il nodo', () => {
    const pulita = ripulisci({ password: 'vera' });
    expect(Object.keys(pulita)).toEqual(['password']);
  });

  it('quello che non è una credenziale passa intero', () => {
    const pulita = ripulisci({ host: 'smtp.aruba.it', port: 587 });
    expect(pulita).toEqual({ host: 'smtp.aruba.it', port: 587 });
  });

  it('un campo vuoto non diventa «nascosto»: non c’era niente da nascondere', () => {
    expect(ripulisci({ password: '' }).password).toBe('');
  });

  it('il prompt porta il contesto, non solo il messaggio', () => {
    // Senza contesto il modello risponde con la spiegazione generica
    // dell'errore, che si trova già su internet.
    const prompt = buildPrompt({
      nodeId: 'invia',
      defId: 'action_send_email',
      error: 'ECONNREFUSED',
      config: { host: 'smtp.aruba.it', password: 'vera' },
    });

    expect(prompt).toContain('invia');
    expect(prompt).toContain('action_send_email');
    expect(prompt).toContain('smtp.aruba.it');
    expect(prompt).not.toContain('vera');
  });

  it('e chiede di non inventare', () => {
    const prompt = buildPrompt({ nodeId: 'a', error: 'boh' });
    expect(prompt).toContain('invece di indovinare');
  });
});
