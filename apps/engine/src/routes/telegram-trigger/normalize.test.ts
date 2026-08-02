/**
 * normalize.ts — Update Telegram → evento normalizzato (contratto del NodeDef
 * trigger_telegram). Bug-bounty: payload rotti, update senza id, callback
 * senza data, foto multi-risoluzione, mai throw.
 */
import { describe, it, expect } from 'vitest';
import { normalizeTelegramUpdate } from './normalize.js';

const CHAT = { id: 42, type: 'private' };
const FROM = { id: 777, username: 'nicola84', first_name: 'Nicola' };

function textUpdate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1001,
    message: {
      message_id: 5,
      from: FROM,
      chat: CHAT,
      date: 1751810400,
      text: 'Vorrei una margherita',
      ...over,
    },
  };
}

describe('normalizeTelegramUpdate — message', () => {
  it('text: chatId/userId/username/testo/timestamp ISO estratti', () => {
    const e = normalizeTelegramUpdate(textUpdate())!;
    expect(e).toMatchObject({
      updateId: 1001,
      kind: 'message',
      messageId: 5,
      chatId: 42,
      chatType: 'private',
      userId: 777,
      username: 'nicola84',
      firstName: 'Nicola',
      text: 'Vorrei una margherita',
      interactive: null,
      media: null,
      location: null,
      replyToMessageId: null,
    });
    expect(e.timestamp).toBe(new Date(1751810400 * 1000).toISOString());
    expect(e.raw).toMatchObject({ update_id: 1001 });
  });

  it('foto: prende il file_id alla MASSIMA risoluzione (ultimo PhotoSize) + caption come text', () => {
    const e = normalizeTelegramUpdate(
      textUpdate({
        text: undefined,
        caption: 'il mio scontrino',
        photo: [
          { file_id: 'small', width: 90 },
          { file_id: 'medium', width: 320 },
          { file_id: 'BEST', width: 1280 },
        ],
      }),
    )!;
    expect(e.media).toEqual({
      kind: 'photo',
      fileId: 'BEST',
      mimeType: null,
      fileName: null,
      caption: 'il mio scontrino',
    });
    expect(e.text).toBe('il mio scontrino');
  });

  it('document: mime e filename nel media ref', () => {
    const e = normalizeTelegramUpdate(
      textUpdate({
        text: undefined,
        document: { file_id: 'DOC1', mime_type: 'application/pdf', file_name: 'menu.pdf' },
      }),
    )!;
    expect(e.media).toMatchObject({
      kind: 'document',
      fileId: 'DOC1',
      mimeType: 'application/pdf',
      fileName: 'menu.pdf',
    });
  });

  it('location + reply_to_message', () => {
    const e = normalizeTelegramUpdate(
      textUpdate({
        location: { latitude: 40.35, longitude: 18.17 },
        reply_to_message: { message_id: 3 },
      }),
    )!;
    expect(e.location).toEqual({ latitude: 40.35, longitude: 18.17 });
    expect(e.replyToMessageId).toBe(3);
  });
});

describe('normalizeTelegramUpdate — callback_query (bottoni inline)', () => {
  it('callback: data come text+interactive.id, mittente = chi ha CLICCATO', () => {
    const e = normalizeTelegramUpdate({
      update_id: 1002,
      callback_query: {
        id: 'cbq1',
        from: { id: 999, username: 'cliccatore', first_name: 'Luca' },
        data: 'CONFERMA_ORDINE',
        message: {
          message_id: 9,
          chat: CHAT,
          date: 1751810400,
          text: 'Confermi il tuo ordine?',
          from: { id: 111 },
        },
      },
    })!;
    expect(e.kind).toBe('callback');
    expect(e.chatId).toBe(42);
    expect(e.userId).toBe(999); // chi clicca, NON l'autore del messaggio coi bottoni
    expect(e.firstName).toBe('Luca');
    expect(e.text).toBe('CONFERMA_ORDINE');
    expect(e.interactive).toEqual({ id: 'CONFERMA_ORDINE', title: 'Confermi il tuo ordine?' });
  });

  it('🚨 callback senza data → null (non azionabile)', () => {
    expect(
      normalizeTelegramUpdate({
        update_id: 1003,
        callback_query: { id: 'x', from: FROM, message: { message_id: 9, chat: CHAT, date: 1 } },
      }),
    ).toBeNull();
  });
});

describe('normalizeTelegramUpdate — edited + bug-bounty', () => {
  it('edited_message → kind=edited', () => {
    const e = normalizeTelegramUpdate({
      update_id: 1004,
      edited_message: { message_id: 5, from: FROM, chat: CHAT, date: 1751810400, text: 'corretto' },
    })!;
    expect(e.kind).toBe('edited');
    expect(e.text).toBe('corretto');
  });

  it.each([
    ['null', null],
    ['stringa', 'x'],
    ['numero', 7],
    ['array', [1]],
    ['oggetto vuoto', {}],
    ['senza update_id', { message: { chat: CHAT, date: 1 } }],
    ['update_id stringa', { update_id: 'x', message: { chat: CHAT, date: 1 } }],
    ['message senza chat', { update_id: 1, message: { date: 1, text: 'x' } }],
    ['chat senza id', { update_id: 1, message: { chat: { type: 'private' }, date: 1 } }],
    ['tipo non gestito (channel_post)', { update_id: 1, channel_post: { chat: CHAT, date: 1 } }],
  ])('%s → null, nessun crash', (_label, payload) => {
    expect(normalizeTelegramUpdate(payload)).toBeNull();
  });

  it('date mancante/invalida → ISO epoch-0 (mai Invalid Date)', () => {
    const e = normalizeTelegramUpdate(textUpdate({ date: 'boom' }))!;
    expect(e.timestamp).toBe(new Date(0).toISOString());
  });

  it('from assente (messaggi anonimi da canale linkato) → userId/username null, evento comunque estratto', () => {
    const e = normalizeTelegramUpdate(textUpdate({ from: undefined }))!;
    expect(e.userId).toBeNull();
    expect(e.username).toBeNull();
    expect(e.chatId).toBe(42);
  });
});
