/** Memorie persistenti dell'AI: fatti durabili iniettati nel system prompt di
 *  ogni conversazione. Editate dall'utente o salvate dal modello via marker
 *  `[[MEMORIZZA: testo]]`, oppure direttamente dai tool `note_*`.
 *
 *  Storage: tabella `notes` nel DB locale — la stessa che vedono i tool.
 *  Prima vivevano solo in localStorage, quindi erano invisibili all'AI. */

import { invoke } from '@tauri-apps/api/core';

export interface Memory {
  id: number;
  topic: string;
  text: string;
  createdAt: string;
  source: 'manual' | 'assistant';
  importance: 'low' | 'normal' | 'high';
}

const LEGACY_KEY = 'medea.ai.memories.v1';

interface LegacyMemory {
  text?: string;
  source?: string;
  importance?: string;
}

/** Migrazione one-shot dalle memorie salvate in localStorage. */
async function migrateLegacy(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const items = JSON.parse(raw) as LegacyMemory[];
    for (const m of items) {
      if (!m.text?.trim()) continue;
      await invoke('db_note_add', {
        note: {
          topic: 'generale',
          text: m.text,
          source: m.source === 'assistant' ? 'assistant' : 'manual',
          importance: m.importance ?? 'normal',
        },
      });
    }
  } catch (e) {
    console.warn('[Medea] migrazione memorie legacy fallita:', e);
  }
  localStorage.removeItem(LEGACY_KEY);
}

let migrated = false;

export async function listMemories(): Promise<Memory[]> {
  if (!migrated) {
    migrated = true;
    await migrateLegacy();
  }
  return invoke<Memory[]>('db_note_list', { topic: null, limit: 200 });
}

export async function addMemory(
  text: string,
  source: Memory['source'] = 'manual',
  importance: Memory['importance'] = 'normal',
  topic = 'generale',
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  await invoke('db_note_add', { note: { topic, text: trimmed, source, importance } });
}

export async function updateMemory(
  id: number,
  patch: { text?: string; importance?: Memory['importance'] },
): Promise<void> {
  await invoke('db_note_update', {
    id,
    text: patch.text ?? null,
    importance: patch.importance ?? null,
  });
}

export async function deleteMemory(id: number): Promise<void> {
  await invoke('db_note_delete', { id });
}

/** Estrae marker `[[MEMORIZZA: ...]]` o `[[REMEMBER: ...]]` da una risposta del modello. */
export function extractMemoriesFromReply(reply: string): string[] {
  const out: string[] = [];
  const re = /\[\[\s*(?:MEMORIZZA|REMEMBER|RICORDA)\s*:\s*([^\]]+?)\s*\]\]/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    const txt = m[1]?.trim();
    if (txt) out.push(txt);
  }
  return out;
}

/** Risposta senza i marker, per visualizzazione. */
export function stripMemoryMarkers(reply: string): string {
  return reply.replace(/\[\[\s*(?:MEMORIZZA|REMEMBER|RICORDA)\s*:[^\]]+?\]\]/giu, '').trim();
}

/** Blocco testo da iniettare nel system prompt. Vuoto se nessuna memoria. */
export async function buildMemoryBlock(): Promise<string> {
  const items = await listMemories();
  if (items.length === 0) return '';
  const lines = items.map((m) => {
    const sev = m.importance === 'high' ? '⚠️ ' : m.importance === 'low' ? '· ' : '';
    return `- ${sev}${m.text}`;
  });
  return `=== MEMORIE PERSISTENTI (sempre valide tra le conversazioni) ===\n${lines.join('\n')}\n=== FINE MEMORIE ===`;
}
