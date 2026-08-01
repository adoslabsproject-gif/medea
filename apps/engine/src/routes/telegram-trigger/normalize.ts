/**
 * Normalizzazione Update Telegram Bot API → evento tipizzato per il workflow.
 *
 * Un POST Telegram porta UN update: { update_id, message? | edited_message? |
 * callback_query? | ... }. Qui si estrae la forma piatta dichiarata (e testata
 * anti-drift) nel NodeDef `trigger_telegram`. Tollerante: payload rotto →
 * null, mai throw su input arbitrario.
 *
 * @module routes/telegram-trigger/normalize
 */

export interface TelegramMediaRef {
  kind: 'photo' | 'document' | 'voice' | 'video' | 'sticker';
  fileId: string;
  mimeType: string | null;
  fileName: string | null;
  caption: string | null;
}

export interface NormalizedTelegramEvent {
  updateId: number;
  kind: 'message' | 'callback' | 'edited';
  messageId: number | null;
  chatId: number;
  chatType: string;
  userId: number | null;
  username: string | null;
  firstName: string | null;
  text: string | null;
  interactive: { id: string; title: string } | null;
  media: TelegramMediaRef | null;
  location: { latitude: number; longitude: number } | null;
  replyToMessageId: number | null;
  /** ISO 8601 UTC dal `date` epoch-seconds Telegram. */
  timestamp: string;
  raw: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function epochToIso(v: unknown): string {
  const n = asNumber(v);
  if (n === null || n <= 0) return new Date(0).toISOString();
  return new Date(n * 1000).toISOString();
}

function extractMedia(msg: Record<string, unknown>): TelegramMediaRef | null {
  const caption = asString(msg.caption);
  // photo = array di PhotoSize risoluzioni crescenti → prendi l'ULTIMA (max res).
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const best = asRecord(msg.photo[msg.photo.length - 1]);
    const fileId = best ? asString(best.file_id) : null;
    if (fileId !== null) return { kind: 'photo', fileId, mimeType: null, fileName: null, caption };
  }
  for (const kind of ['document', 'voice', 'video', 'sticker'] as const) {
    const m = asRecord(msg[kind]);
    const fileId = m ? asString(m.file_id) : null;
    if (m && fileId !== null) {
      return {
        kind,
        fileId,
        mimeType: asString(m.mime_type),
        fileName: asString(m.file_name),
        caption,
      };
    }
  }
  return null;
}

function baseFromMessage(
  updateId: number,
  kind: NormalizedTelegramEvent['kind'],
  msg: Record<string, unknown>,
  raw: Record<string, unknown>,
): NormalizedTelegramEvent | null {
  const chat = asRecord(msg.chat);
  const chatId = chat ? asNumber(chat.id) : null;
  if (chatId === null) return null; // senza chat non si può né processare né rispondere
  const from = asRecord(msg.from);
  const media = extractMedia(msg);
  const loc = asRecord(msg.location);
  const latitude = loc ? asNumber(loc.latitude) : null;
  const longitude = loc ? asNumber(loc.longitude) : null;
  const replyTo = asRecord(msg.reply_to_message);
  return {
    updateId,
    kind,
    messageId: asNumber(msg.message_id),
    chatId,
    chatType: (chat ? asString(chat.type) : null) ?? 'private',
    userId: from ? asNumber(from.id) : null,
    username: from ? asString(from.username) : null,
    firstName: from ? asString(from.first_name) : null,
    text: asString(msg.text) ?? media?.caption ?? null,
    interactive: null,
    media,
    location: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    replyToMessageId: replyTo ? asNumber(replyTo.message_id) : null,
    timestamp: epochToIso(msg.date),
    raw,
  };
}

/**
 * Normalizza un Update Telegram. Ritorna null per update non processabili
 * (tipo non gestito, struttura rotta, update_id mancante) — mai throw.
 */
export function normalizeTelegramUpdate(payload: unknown): NormalizedTelegramEvent | null {
  const update = asRecord(payload);
  if (!update) return null;
  const updateId = asNumber(update.update_id);
  if (updateId === null) return null; // indedupabile → non processabile

  const message = asRecord(update.message);
  if (message) return baseFromMessage(updateId, 'message', message, update);

  const edited = asRecord(update.edited_message);
  if (edited) return baseFromMessage(updateId, 'edited', edited, update);

  const callback = asRecord(update.callback_query);
  if (callback) {
    // Il "messaggio" del callback è quello che PORTAVA i bottoni: chat/ids da lì.
    const carrier = asRecord(callback.message);
    if (!carrier) return null;
    const base = baseFromMessage(updateId, 'callback', carrier, update);
    if (!base) return null;
    const from = asRecord(callback.from); // chi ha CLICCATO (non l'autore del carrier)
    const data = asString(callback.data);
    if (data === null) return null; // callback senza data non è azionabile
    return {
      ...base,
      userId: from ? asNumber(from.id) : null,
      username: from ? asString(from.username) : null,
      firstName: from ? asString(from.first_name) : null,
      text: data,
      interactive: { id: data, title: asString(carrier.text) ?? '' },
    };
  }

  return null; // channel_post/poll/altro: fuori scope del trigger conversazionale
}
