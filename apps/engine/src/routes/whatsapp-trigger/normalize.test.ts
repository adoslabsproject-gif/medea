/**
 * normalize.ts — payload Meta → messaggi/status normalizzati.
 *
 * Copre il contratto dichiarato nel NodeDef trigger_whatsapp (outputContract)
 * + bug-bounty su payload rotti: null, tipi sbagliati, messaggi senza id,
 * field diversi da 'messages', batching multiplo. La funzione NON deve mai
 * lanciare su input arbitrario.
 */
import { describe, it, expect } from 'vitest';
import { extractWhatsAppEvents } from './normalize.js';

/** Payload Meta realistico con un messaggio text. */
function metaEnvelope(value: Record<string, unknown>): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-1', changes: [{ field: 'messages', value }] }],
  };
}

const METADATA = { display_phone_number: '39061234567', phone_number_id: 'PNID-1' };
const CONTACT = { wa_id: '393331234567', profile: { name: 'Nicola' } };

function textMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: '393331234567',
    id: 'wamid.MSG1',
    timestamp: '1751810400', // 2025-07-06T14:00:00Z circa — verificato sotto in ISO
    type: 'text',
    text: { body: 'Vorrei una margherita' },
    ...over,
  };
}

describe('extractWhatsAppEvents — messaggi', () => {
  it('text: estrae from/id/testo/profilo/metadata e timestamp ISO 8601', () => {
    const { messages, statuses } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        contacts: [CONTACT],
        messages: [textMessage()],
      }),
    );
    expect(statuses).toHaveLength(0);
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.kind).toBe('message');
    expect(m.messageId).toBe('wamid.MSG1');
    expect(m.from).toBe('393331234567');
    expect(m.profileName).toBe('Nicola');
    expect(m.phoneNumberId).toBe('PNID-1');
    expect(m.displayPhoneNumber).toBe('39061234567');
    expect(m.type).toBe('text');
    expect(m.text).toBe('Vorrei una margherita');
    expect(m.interactive).toBeNull();
    expect(m.media).toBeNull();
    expect(m.location).toBeNull();
    expect(m.replyToMessageId).toBeNull();
    // ISO 8601 strict UTC dal timestamp epoch (1751810400 * 1000)
    expect(m.timestamp).toBe(new Date(1751810400 * 1000).toISOString());
    expect(m.raw).toMatchObject({ id: 'wamid.MSG1' });
  });

  it('interactive button_reply: id+title in interactive, title come text', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'interactive',
            text: undefined,
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'ORDINA_SOLITA', title: 'La solita 🍕' },
            },
          }),
        ],
      }),
    );
    expect(messages[0]!.interactive).toEqual({ id: 'ORDINA_SOLITA', title: 'La solita 🍕' });
    expect(messages[0]!.text).toBe('La solita 🍕');
  });

  it('interactive list_reply: stessa normalizzazione del button_reply', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'interactive',
            text: undefined,
            interactive: {
              type: 'list_reply',
              list_reply: { id: 'PIZZA_4', title: 'Quattro Stagioni', description: 'pomodoro…' },
            },
          }),
        ],
      }),
    );
    expect(messages[0]!.interactive).toEqual({ id: 'PIZZA_4', title: 'Quattro Stagioni' });
  });

  it('button legacy dei template (payload+text) → interactive', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'button',
            text: undefined,
            button: { payload: 'CONFERMA', text: 'Conferma ordine' },
          }),
        ],
      }),
    );
    expect(messages[0]!.interactive).toEqual({ id: 'CONFERMA', title: 'Conferma ordine' });
    expect(messages[0]!.text).toBe('Conferma ordine');
  });

  it('image con caption: media ref completo + caption come text (byte NON inclusi)', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'image',
            text: undefined,
            image: {
              id: 'MEDIA-9',
              mime_type: 'image/jpeg',
              sha256: 'abc123',
              caption: 'la mia fattura',
            },
          }),
        ],
      }),
    );
    const m = messages[0]!;
    expect(m.media).toEqual({
      id: 'MEDIA-9',
      mimeType: 'image/jpeg',
      sha256: 'abc123',
      caption: 'la mia fattura',
      filename: null,
    });
    expect(m.text).toBe('la mia fattura');
  });

  it('document: filename presente nel media ref', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'document',
            text: undefined,
            document: { id: 'DOC-1', mime_type: 'application/pdf', filename: 'fattura.pdf' },
          }),
        ],
      }),
    );
    expect(messages[0]!.media).toMatchObject({ id: 'DOC-1', filename: 'fattura.pdf' });
  });

  it('location: coordinate numeriche obbligatorie, name/address opzionali', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'location',
            text: undefined,
            location: { latitude: 41.9, longitude: 12.49, name: 'Casa', address: 'Via Roma 1' },
          }),
        ],
      }),
    );
    expect(messages[0]!.location).toEqual({
      latitude: 41.9,
      longitude: 12.49,
      name: 'Casa',
      address: 'Via Roma 1',
    });
  });

  it('🚨 location con coordinate stringa (malformata) → location null, messaggio comunque estratto', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'location',
            text: undefined,
            location: { latitude: '41.9', longitude: '12.49' },
          }),
        ],
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.location).toBeNull();
  });

  it('reaction: emoji come text', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({
            type: 'reaction',
            text: undefined,
            reaction: { message_id: 'wamid.X', emoji: '👍' },
          }),
        ],
      }),
    );
    expect(messages[0]!.text).toBe('👍');
  });

  it('context di reply → replyToMessageId', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [textMessage({ context: { from: '39061234567', id: 'wamid.QUOTED' } })],
      }),
    );
    expect(messages[0]!.replyToMessageId).toBe('wamid.QUOTED');
  });

  it('batching: 3 messaggi nello stesso POST → 3 eventi normalizzati in ordine', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          textMessage({ id: 'wamid.A' }),
          textMessage({ id: 'wamid.B', type: 'unknown-future-type' }),
          textMessage({ id: 'wamid.C' }),
        ],
      }),
    );
    expect(messages.map((m) => m.messageId)).toEqual(['wamid.A', 'wamid.B', 'wamid.C']);
    // Tipo sconosciuto: preservato as-is, text null, nessun crash.
    expect(messages[1]!.type).toBe('unknown-future-type');
    expect(messages[1]!.text).toBeNull();
  });

  it('mittente senza contact corrispondente → profileName null', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        contacts: [{ wa_id: 'ALTRO-NUMERO', profile: { name: 'Qualcun altro' } }],
        messages: [textMessage()],
      }),
    );
    expect(messages[0]!.profileName).toBeNull();
  });
});

describe('extractWhatsAppEvents — statuses', () => {
  it('status delivered estratto con recipient e kind=status', () => {
    const { statuses } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        statuses: [
          {
            id: 'wamid.SENT1',
            status: 'delivered',
            timestamp: '1751810400',
            recipient_id: '393331234567',
          },
        ],
      }),
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      kind: 'status',
      messageId: 'wamid.SENT1',
      status: 'delivered',
      recipientId: '393331234567',
      phoneNumberId: 'PNID-1',
    });
  });

  it('status senza id o senza status → scartato', () => {
    const { statuses } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        statuses: [{ status: 'read' }, { id: 'wamid.X' }, 'garbage', null],
      }),
    );
    expect(statuses).toHaveLength(0);
  });
});

describe('extractWhatsAppEvents — bug-bounty payload rotti (mai throw)', () => {
  it.each([
    ['null', null],
    ['stringa', 'not-json-object'],
    ['numero', 42],
    ['array', [1, 2]],
    ['oggetto vuoto', {}],
    ['entry non-array', { entry: 'x' }],
    ['entry di null', { entry: [null, 3, 'x'] }],
    ['changes non-array', { entry: [{ changes: {} }] }],
    ['value null', { entry: [{ changes: [{ field: 'messages', value: null }] }] }],
    [
      'messages non-array',
      { entry: [{ changes: [{ field: 'messages', value: { messages: 'x' } }] }] },
    ],
  ])('%s → zero eventi, nessun crash', (_label, payload) => {
    const out = extractWhatsAppEvents(payload);
    expect(out.messages).toHaveLength(0);
    expect(out.statuses).toHaveLength(0);
  });

  it('🚨 messaggio senza id o senza from → SCARTATO (indedupabile), gli altri del batch sopravvivono', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [
          { from: '393331234567', type: 'text', text: { body: 'senza id' } },
          { id: 'wamid.SENZA-FROM', type: 'text' },
          textMessage({ id: 'wamid.OK' }),
        ],
      }),
    );
    expect(messages.map((m) => m.messageId)).toEqual(['wamid.OK']);
  });

  it('field diverso da "messages" (es. account_update) → ignorato', () => {
    const out = extractWhatsAppEvents({
      entry: [{ changes: [{ field: 'account_update', value: { messages: [textMessage()] } }] }],
    });
    expect(out.messages).toHaveLength(0);
  });

  it('timestamp mancante/invalido → ISO epoch-0 (mai Invalid Date / NaN)', () => {
    const { messages } = extractWhatsAppEvents(
      metaEnvelope({
        metadata: METADATA,
        messages: [textMessage({ timestamp: 'not-a-number' })],
      }),
    );
    expect(messages[0]!.timestamp).toBe(new Date(0).toISOString());
  });

  it('metadata assente → phoneNumberId stringa vuota, displayPhoneNumber null (messaggio comunque estratto)', () => {
    const { messages } = extractWhatsAppEvents(metaEnvelope({ messages: [textMessage()] }));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.phoneNumberId).toBe('');
    expect(messages[0]!.displayPhoneNumber).toBeNull();
  });
});
