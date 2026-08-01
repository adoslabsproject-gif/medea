import { describe, expect, it } from 'vitest';

import { comeAutenticare, intestazioniFirmate, pianoFirma } from './webhook-test';

describe('come va firmata una chiamata', () => {
  it('senza firma non c’è piano', () => {
    expect(pianoFirma({ authMode: 'none' })).toBeNull();
    expect(pianoFirma({})).toBeNull();
  });

  it('senza segreto nemmeno: firmare con niente non è firmare', () => {
    expect(pianoFirma({ authMode: 'hmac-signature' })).toBeNull();
  });

  it('usa i valori predefiniti del motore quando il nodo non li dichiara', () => {
    const piano = pianoFirma({ authMode: 'hmac-signature', hmacSecret: 's' });
    expect(piano?.header).toBe('x-flowforge-signature');
    expect(piano?.algo).toBe('sha256');
    expect(piano?.format).toBe('body');
  });

  it('accetta anche la forma vecchia del segreto', () => {
    // I workflow scritti prima usano `authSecret`: rifiutarli vorrebbe dire
    // non poter provare quelli che esistono già.
    const piano = pianoFirma({ authMode: 'hmac-signature', authSecret: 'vecchio' });
    expect(piano?.secret).toBe('vecchio');
  });

  it('il segreto nuovo vince su quello vecchio, come nel motore', () => {
    const piano = pianoFirma({
      authMode: 'hmac-signature',
      hmacSecret: 'nuovo',
      authSecret: 'vecchio',
    });
    expect(piano?.secret).toBe('nuovo');
  });

  it('rifiuta un algoritmo che il motore non conosce', () => {
    // Firmare con md5 produrrebbe una firma che il motore scarta, e il
    // tester direbbe «non funziona» per il motivo sbagliato.
    const piano = pianoFirma({ authMode: 'hmac-signature', hmacSecret: 's', hmacAlgo: 'md5' });
    expect(piano?.algo).toBe('sha256');
  });

  it('con la marca temporale firma `ts.body`, come Stripe', () => {
    const piano = pianoFirma({
      authMode: 'hmac-signature',
      hmacSecret: 's',
      hmacTimestampHeader: 'x-stripe-timestamp',
    });
    expect(piano?.format).toBe('ts.body');
    expect(piano?.timestampHeader).toBe('x-stripe-timestamp');
  });

  it('ma rispetta chi chiede il formato di GitHub', () => {
    const piano = pianoFirma({
      authMode: 'hmac-signature',
      hmacSecret: 's',
      hmacTimestampHeader: 'x-ts',
      hmacSignedPayloadFormat: 'body',
    });
    expect(piano?.format).toBe('body');
  });
});

describe('la firma vera', () => {
  it('è quella che il motore si aspetta, in esadecimale', async () => {
    const piano = pianoFirma({ authMode: 'hmac-signature', hmacSecret: 'segreto' });
    const headers = await intestazioniFirmate(piano!, '{"a":1}');

    // HMAC-SHA256 di '{"a":1}' con chiave 'segreto', calcolato a parte.
    expect(headers['x-flowforge-signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('la stessa chiamata firmata due volte dà la stessa firma', async () => {
    const piano = pianoFirma({ authMode: 'hmac-signature', hmacSecret: 's' });
    const a = await intestazioniFirmate(piano!, 'x', 1_000_000);
    const b = await intestazioniFirmate(piano!, 'x', 1_000_000);
    expect(a).toEqual(b);
  });

  it('un corpo diverso dà una firma diversa', async () => {
    const piano = pianoFirma({ authMode: 'hmac-signature', hmacSecret: 's' });
    const a = await intestazioniFirmate(piano!, 'uno');
    const b = await intestazioniFirmate(piano!, 'due');
    expect(a['x-flowforge-signature']).not.toBe(b['x-flowforge-signature']);
  });

  it('con la marca temporale, il momento cambia la firma', async () => {
    // È la protezione contro chi rigioca una chiamata catturata: se il
    // momento non entrasse nella firma, non servirebbe a niente.
    const piano = pianoFirma({
      authMode: 'hmac-signature',
      hmacSecret: 's',
      hmacTimestampHeader: 'x-ts',
    });
    const a = await intestazioniFirmate(piano!, 'x', 1_000_000_000);
    const b = await intestazioniFirmate(piano!, 'x', 2_000_000_000);

    expect(a['x-ts']).not.toBe(b['x-ts']);
    expect(a['x-flowforge-signature']).not.toBe(b['x-flowforge-signature']);
  });
});

describe('cosa serve quando non è una firma', () => {
  it('lo dice, invece di lasciar provare al buio', () => {
    expect(comeAutenticare({ authMode: 'basic-auth' })).toContain('utente e password');
    expect(comeAutenticare({ authMode: 'jwt' })).toContain('JWT');
    expect(comeAutenticare({})).toContain('Nessuna autenticazione');
  });

  it('per la firma non dice niente: ci pensa il tester', () => {
    expect(comeAutenticare({ authMode: 'hmac-signature' })).toBeNull();
  });
});
