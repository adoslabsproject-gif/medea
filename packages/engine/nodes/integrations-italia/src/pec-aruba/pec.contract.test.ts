/**
 * Contract test ANTI-DRIFT — italia_pec_aruba_send / _receive.
 *
 * Storia (review nodi): la description di _receive prometteva un output ricco
 * { to, body, attachments[], pecHeaders, pecType } che l'executor NON produceva
 * (estraeva solo envelope: subject/from/date/messageId). RISOLTO IMPLEMENTANDO
 * l'estrazione completa (pec-message.ts: simpleParser + classifyPecType). Questo
 * guard lega la description ai campi REALMENTE esposti dal modulo (PecParsedMessage)
 * e ai valori pecType reali → un claim che torna a divergere = rosso.
 *
 * NB: il modulo runtime (pec-message) vive in apps/engine; qui asseriamo
 * la COERENZA della description del nodo con il contratto documentato, senza
 * importare il runtime (package boundary). I valori sono pinnati esplicitamente.
 */
import { describe, it, expect } from 'vitest';
import { pecArubaSend, pecArubaReceive } from './index.js';

describe('italia_pec_aruba_receive — contract description ⊆ output reale (anti-drift)', () => {
  const description = pecArubaReceive.def.description ?? '';

  it('🚨 dichiara i campi di output REALMENTE prodotti dall\'executor', () => {
    for (const field of ['messageId', 'from', 'to', 'subject', 'body', 'attachments', 'pecHeaders', 'pecType']) {
      expect(description, `campo "${field}" non documentato`).toContain(field);
    }
  });

  it('🚨 i 4 valori pecType sono documentati (mappati dagli header PEC normati)', () => {
    for (const t of ['received', 'acceptance', 'delivery', 'reject']) {
      expect(description, `pecType "${t}" non documentato`).toContain(t);
    }
  });

  it('cita la base normativa del pecType (DPR 68/2005) — non è un campo inventato', () => {
    expect(description).toMatch(/DPR\s*68\/2005/i);
  });
});

describe('italia_pec_aruba_send — contract (onesto su transport/allegati)', () => {
  const description = pecArubaSend.def.description ?? '';
  const transport = pecArubaSend.def.configFields?.find((f) => f.key === 'transport');
  const options = transport?.type === 'select' ? transport.options : [];

  it('i transport citati ⊆ enum reale (smtp/soap)', () => {
    expect([...options].sort()).toEqual(['smtp', 'soap']);
    expect(description).toMatch(/SMTP/i);
    expect(description).toMatch(/SOAP/i);
  });
});
