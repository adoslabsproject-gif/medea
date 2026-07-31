import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useEffect } from 'react';

interface ReminderRow {
  id: number;
  text: string;
  dueAt: string;
  notes: string | null;
  organizationName: string | null;
}

const POLL_MS = 60_000;

/**
 * Dispatcher dei promemoria: ogni minuto controlla quelli scaduti e li
 * trasforma in notifiche OS native, marcandoli come già notificati.
 *
 * Prima i reminder si salvavano e basta: nessuno li leggeva mai.
 */
export function useReminderNotifications(): void {
  useEffect(() => {
    let cancelled = false;
    let granted = false;

    async function ensurePermission(): Promise<boolean> {
      if (granted) return true;
      try {
        granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
      } catch (e) {
        console.warn('[Medea] permesso notifiche non disponibile:', e);
        granted = false;
      }
      return granted;
    }

    async function tick() {
      try {
        const due = await invoke<ReminderRow[]>('db_reminders_due');
        if (cancelled || due.length === 0) return;
        if (!(await ensurePermission())) return;
        for (const r of due) {
          const who = r.organizationName ? ` · ${r.organizationName}` : '';
          sendNotification({
            title: `⏰ Promemoria${who}`,
            body: r.notes ? `${r.text}\n${r.notes}` : r.text,
          });
          await invoke('db_reminder_mark_fired', { id: r.id });
        }
      } catch (e) {
        console.warn('[Medea] controllo promemoria fallito:', e);
      }
    }

    void tick();
    const timer = window.setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
