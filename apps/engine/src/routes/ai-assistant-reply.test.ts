/**
 * Bug-bounty del modulo PURO di robustezza chat (strato 2: estrazione + fallback).
 *
 * Invariante centrale (incident 2026-06-16): coerceAssistantReply NON lancia MAI e
 * restituisce SEMPRE un reply con `message` stringa non vuota — la chat di Liara
 * risponde in ogni caso, anche su output spazzatura. + contract anti-drift tra lo
 * schema guided_json e lo Zod schema della route.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  stripCodeFences,
  extractFirstJsonObject,
  coerceAssistantReply,
  AssistantReplySchema,
  ASSISTANT_REPLY_JSON_SCHEMA,
} from './ai-assistant-reply.js';

const safeParse = (v: unknown) => {
  const r = AssistantReplySchema.safeParse(v);
  return r.success ? ({ success: true, data: r.data } as const) : ({ success: false } as const);
};

describe('stripCodeFences', () => {
  it('toglie ```json … ```', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('toglie ``` senza lang', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('testo senza fence → trim', () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('extractFirstJsonObject — scan bilanciato', () => {
  it("estrae l'oggetto in mezzo a prosa", () => {
    expect(extractFirstJsonObject('bla bla {"a":1} ciao')).toEqual({ a: 1 });
  });
  it('🔒 ignora le graffe DENTRO le stringhe (non si ferma alla } interna)', () => {
    expect(extractFirstJsonObject('x {"msg":"ho usato } e { qui","ok":true} y')).toEqual({
      msg: 'ho usato } e { qui',
      ok: true,
    });
  });
  it("🔒 gestisce l'escape dei doppi apici nelle stringhe", () => {
    expect(extractFirstJsonObject('{"q":"dice \\"ciao}\\" a tutti"}')).toEqual({
      q: 'dice "ciao}" a tutti',
    });
  });
  it('oggetti annidati → ritorna il primo bilanciato completo', () => {
    expect(extractFirstJsonObject('pre {"a":{"b":2}} post')).toEqual({ a: { b: 2 } });
  });
  it('nessuna graffa → undefined', () => {
    expect(extractFirstJsonObject('solo testo')).toBeUndefined();
  });
  it('graffa aperta non chiusa → undefined (non lancia)', () => {
    expect(extractFirstJsonObject('{"a":1 senza chiusura')).toBeUndefined();
  });
  it('contenuto non-JSON tra graffe bilanciate → undefined (parse fallisce, no throw)', () => {
    expect(extractFirstJsonObject('{ questo non e json }')).toBeUndefined();
  });
});

describe('coerceAssistantReply — invariante: SEMPRE un reply valido, MAI throw', () => {
  it('envelope valido conforme → reply + conformed:true', () => {
    const r = coerceAssistantReply('{"message":"ok","patch":{"removeEdgeIds":["e1"]}}', safeParse);
    expect(r.conformed).toBe(true);
    if (!r.conformed) throw new Error('atteso conformed:true');
    expect(r.reply.message).toBe('ok');
    expect(r.reply.patch?.removeEdgeIds).toEqual(['e1']);
  });

  it('envelope dentro fence → parsato', () => {
    const r = coerceAssistantReply('```json\n{"message":"ciao"}\n```', safeParse);
    expect(r.conformed).toBe(true);
    expect(r.reply.message).toBe('ciao');
  });

  it('🚨 prosa pura (non-JSON) → fallback {message:testo}, conformed:false (no throw)', () => {
    const r = coerceAssistantReply('Certo, posso aiutarti!', safeParse);
    expect(r.conformed).toBe(false);
    expect(r.reply.message).toBe('Certo, posso aiutarti!');
  });

  it("🚨 prosa + JSON valido in mezzo → estrae l'envelope", () => {
    const r = coerceAssistantReply(
      'Ecco:\n{"message":"fatto","patch":{"removeNodeIds":["n1"]}}\nok?',
      safeParse,
    );
    expect(r.conformed).toBe(true);
    if (!r.conformed) throw new Error('atteso conformed:true');
    expect(r.reply.message).toBe('fatto');
    expect(r.reply.patch?.removeNodeIds).toEqual(['n1']);
  });

  it('🚨 JSON valido ma senza message (schema-invalido) → fallback al testo grezzo', () => {
    const r = coerceAssistantReply('{"foo":"bar"}', safeParse);
    expect(r.conformed).toBe(false);
    expect(r.reply.message).toBe('{"foo":"bar"}');
  });

  it('🚨 JSON con message valido MA patch malformata → tiene SOLO il message (scarta patch rotta)', () => {
    // patch.addNodes con elemento senza defId → Zod fallisce. Si salva il messaggio.
    const r = coerceAssistantReply(
      '{"message":"ci provo","patch":{"addNodes":[{"id":"n1"}]}}',
      safeParse,
    );
    expect(r.conformed).toBe(false);
    expect(r.reply.message).toBe('ci provo');
    expect('patch' in r.reply).toBe(false);
  });

  it('🚨 stringa vuota → message di default non vuoto (mai vuoto)', () => {
    const r = coerceAssistantReply('', safeParse);
    expect(r.conformed).toBe(false);
    expect(r.reply.message.length).toBeGreaterThan(0);
  });

  it('🚨 JSON array al top (non oggetto) → fallback (non è un envelope)', () => {
    const r = coerceAssistantReply('[1,2,3]', safeParse);
    expect(r.conformed).toBe(false);
    expect(r.reply.message).toBe('[1,2,3]');
  });

  it('🔒 message con graffe interne → estratto integro (no troncamento)', () => {
    const r = coerceAssistantReply('{"message":"usa la sintassi {{var}} così"}', safeParse);
    expect(r.conformed).toBe(true);
    expect(r.reply.message).toBe('usa la sintassi {{var}} così');
  });
});

describe('🔒 ANTI-DRIFT: schema guided_json ↔ AssistantReplySchema (Zod)', () => {
  it('un envelope completo valido passa SIA lo Zod schema SIA lo schema guided_json (chiavi patch coincidono)', () => {
    const sample = {
      message: 'm',
      patch: {
        addNodes: [{ id: 'n1', defId: 'http_request' }],
        removeNodeIds: ['n2'],
        addEdges: [{ id: 'e1', from: 'n1', to: 'n2' }],
        removeEdgeIds: ['e3'],
        updateNodes: [{ id: 'n1', patch: { label: 'x' } }],
      },
    };
    // Zod accetta.
    expect(AssistantReplySchema.safeParse(sample).success).toBe(true);
    // Le chiavi di patch dichiarate nello schema guided_json coincidono ESATTAMENTE
    // con quelle Zod → se una delle due deriva, questo test rompe.
    const jsonSchemaPatchKeys = Object.keys(
      ASSISTANT_REPLY_JSON_SCHEMA.properties.patch.properties,
    ).sort();
    const zodPatchKeys = Object.keys(
      (AssistantReplySchema.shape.patch.unwrap() as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    expect(jsonSchemaPatchKeys).toEqual(zodPatchKeys);
    expect(jsonSchemaPatchKeys).toEqual(sample.patch && Object.keys(sample.patch).sort());
  });

  it('lo schema guided_json richiede `message` (envelope mai senza messaggio)', () => {
    expect(ASSISTANT_REPLY_JSON_SCHEMA.required).toContain('message');
  });
});
