/**
 * Normalizzazione payload webhook Meta Cloud API → messaggi/status tipizzati.
 *
 * Un POST Meta ha shape { object, entry: [{ changes: [{ field: 'messages',
 * value: { metadata, contacts, messages?, statuses? } }] }] } e può contenere
 * N messaggi in batch. Qui si estrae OGNI messaggio in una forma piatta e
 * stabile per il workflow (una run per messaggio, vedi index.ts), tollerando
 * campi assenti/malformati: un payload rotto produce zero eventi, mai throw.
 *
 * Il contratto dei campi è dichiarato (e testato anti-drift) nel NodeDef
 * `trigger_whatsapp` (packages/flowforge/nodes/stdlib/src/triggers/whatsapp.ts).
 *
 * @module routes/whatsapp-trigger/normalize
 */

export interface WhatsAppMediaRef {
  id: string;
  mimeType: string | null;
  sha256: string | null;
  caption: string | null;
  filename: string | null;
}

export interface WhatsAppLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
}

export interface NormalizedWhatsAppMessage {
  kind: 'message';
  messageId: string;
  from: string;
  profileName: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  /** ISO 8601 UTC (dal timestamp epoch-seconds Meta). */
  timestamp: string;
  type: string;
  text: string | null;
  interactive: { id: string; title: string } | null;
  media: WhatsAppMediaRef | null;
  location: WhatsAppLocation | null;
  replyToMessageId: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedWhatsAppStatus {
  kind: 'status';
  messageId: string;
  status: string;
  recipientId: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  timestamp: string;
  raw: Record<string, unknown>;
}

const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Epoch-seconds Meta (stringa o numero) → ISO 8601 UTC. Invalido → epoch 0 mai: fallback a null-ish "". */
function epochToIso(v: unknown): string {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return new Date(0).toISOString();
  return new Date(n * 1000).toISOString();
}

function extractMedia(msg: Record<string, unknown>, type: string): WhatsAppMediaRef | null {
  if (!MEDIA_TYPES.has(type)) return null;
  const m = asRecord(msg[type]);
  const id = m ? asString(m.id) : null;
  if (!m || id === null) return null;
  return {
    id,
    mimeType: asString(m.mime_type),
    sha256: asString(m.sha256),
    caption: asString(m.caption),
    filename: asString(m.filename),
  };
}

function extractInteractive(msg: Record<string, unknown>): { id: string; title: string } | null {
  const interactive = asRecord(msg.interactive);
  if (interactive) {
    const reply = asRecord(interactive.button_reply) ?? asRecord(interactive.list_reply);
    const id = reply ? asString(reply.id) : null;
    const title = reply ? asString(reply.title) : null;
    if (id !== null && title !== null) return { id, title };
    return null;
  }
  // Legacy quick-reply dei template: { button: { payload, text } }
  const button = asRecord(msg.button);
  if (button) {
    const id = asString(button.payload);
    const title = asString(button.text);
    if (id !== null && title !== null) return { id, title };
  }
  return null;
}

/** Corpo testuale unificato: text.body, caption media, titolo reply, emoji reaction. */
function extractText(msg: Record<string, unknown>, type: string, interactive: { id: string; title: string } | null): string | null {
  if (type === 'text') {
    const t = asRecord(msg.text);
    return t ? asString(t.body) : null;
  }
  if (interactive !== null) return interactive.title;
  if (MEDIA_TYPES.has(type)) {
    const m = asRecord(msg[type]);
    return m ? asString(m.caption) : null;
  }
  if (type === 'reaction') {
    const r = asRecord(msg.reaction);
    return r ? asString(r.emoji) : null;
  }
  return null;
}

function extractLocation(msg: Record<string, unknown>, type: string): WhatsAppLocation | null {
  if (type !== 'location') return null;
  const loc = asRecord(msg.location);
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return null;
  return {
    latitude: loc.latitude,
    longitude: loc.longitude,
    name: asString(loc.name),
    address: asString(loc.address),
  };
}

export interface ExtractedWhatsAppEvents {
  messages: NormalizedWhatsAppMessage[];
  statuses: NormalizedWhatsAppStatus[];
}

/**
 * Estrae e normalizza TUTTI i messaggi e status dal payload webhook Meta.
 * Tollerante: entry/changes/value malformati vengono saltati in silenzio
 * (zero eventi ≠ errore — Meta manda anche eventi di field diversi da
 * 'messages' che non ci riguardano). Mai throw su input arbitrario.
 */
export function extractWhatsAppEvents(payload: unknown): ExtractedWhatsAppEvents {
  const out: ExtractedWhatsAppEvents = { messages: [], statuses: [] };
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.entry)) return out;

  for (const entryRaw of root.entry) {
    const entry = asRecord(entryRaw);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const changeRaw of entry.changes) {
      const change = asRecord(changeRaw);
      if (!change) continue;
      if (change.field !== 'messages') continue;
      const value = asRecord(change.value);
      if (!value) continue;

      const metadata = asRecord(value.metadata);
      const phoneNumberId = metadata ? asString(metadata.phone_number_id) ?? '' : '';
      const displayPhoneNumber = metadata ? asString(metadata.display_phone_number) : null;

      // contacts[] è parallelo a messages[] solo in teoria; in pratica Meta
      // manda un contact per mittente. Mappa wa_id → profile.name.
      const profileByWaId = new Map<string, string>();
      if (Array.isArray(value.contacts)) {
        for (const contactRaw of value.contacts) {
          const contact = asRecord(contactRaw);
          const waId = contact ? asString(contact.wa_id) : null;
          const profile = contact ? asRecord(contact.profile) : null;
          const name = profile ? asString(profile.name) : null;
          if (waId !== null && name !== null) profileByWaId.set(waId, name);
        }
      }

      if (Array.isArray(value.messages)) {
        for (const msgRaw of value.messages) {
          const msg = asRecord(msgRaw);
          if (!msg) continue;
          const messageId = asString(msg.id);
          const from = asString(msg.from);
          if (messageId === null || from === null) continue; // senza id/mittente non è processabile né dedupabile
          const type = asString(msg.type) ?? 'unknown';
          const interactive = extractInteractive(msg);
          const context = asRecord(msg.context);
          out.messages.push({
            kind: 'message',
            messageId,
            from,
            profileName: profileByWaId.get(from) ?? null,
            phoneNumberId,
            displayPhoneNumber,
            timestamp: epochToIso(msg.timestamp),
            type,
            text: extractText(msg, type, interactive),
            interactive,
            media: extractMedia(msg, type),
            location: extractLocation(msg, type),
            replyToMessageId: context ? asString(context.id) : null,
            raw: msg,
          });
        }
      }

      if (Array.isArray(value.statuses)) {
        for (const stRaw of value.statuses) {
          const st = asRecord(stRaw);
          if (!st) continue;
          const messageId = asString(st.id);
          const status = asString(st.status);
          if (messageId === null || status === null) continue;
          out.statuses.push({
            kind: 'status',
            messageId,
            status,
            recipientId: asString(st.recipient_id),
            phoneNumberId,
            displayPhoneNumber,
            timestamp: epochToIso(st.timestamp),
            raw: st,
          });
        }
      }
    }
  }
  return out;
}
