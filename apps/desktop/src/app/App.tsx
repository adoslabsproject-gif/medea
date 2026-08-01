import { useEffect, useRef, useState } from 'react';

import { AccountSetup } from '../features/account-setup';
import { mailApi } from '../features/mail/api';
import { useAccountStore } from '../features/mail/store/account-store';
import type { MailAccount } from '../features/mail/types';
import { useReminderNotifications } from '../features/reminders/useReminderNotifications';
import { AppShell } from '../features/shell';
import { useAutonomousRuns } from '../features/workflows';

import { THEME_KEY, ThemeProvider, type ThemeMode } from './providers/ThemeProvider';

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? 'system',
  );
  function changeTheme(m: ThemeMode) {
    localStorage.setItem(THEME_KEY, m);
    setTheme(m);
  }
  return (
    <ThemeProvider value={theme} onChange={changeTheme}>
      <Root />
    </ThemeProvider>
  );
}

function Root() {
  const store = useAccountStore();
  const [forceSetup, setForceSetup] = useState(false);
  /** Chi ha scelto di guardare l'app senza configurare la posta. Vale per
   *  questa sessione: alla riapertura la domanda torna, perché senza un
   *  account l'app fa meno di quello che sa fare. */
  const [skipped, setSkipped] = useState(false);
  const synced = useRef(false);
  useReminderNotifications();
  // Le automazioni attive devono girare anche se non si apre mai la sezione.
  useAutonomousRuns();

  // Al boot: assicura che gli account presenti in localStorage siano anche
  // nel DB SQLite (necessario per le foreign key di folders/messages).
  // Idempotente: db_account_upsert fa ON CONFLICT UPDATE.
  useEffect(() => {
    if (!store.loaded || synced.current) return;
    synced.current = true;
    void (async () => {
      for (const acc of store.accounts) {
        try {
          await mailApi.db.accountUpsert(acc);
        } catch (e) {
          console.error(`DB upsert ${acc.id} failed:`, e);
        }
      }
    })();
  }, [store.loaded, store.accounts]);

  async function persistNew(acc: MailAccount) {
    await store.addAccount(acc);
    try {
      await mailApi.db.accountUpsert(acc);
    } catch (e) {
      console.error('DB upsert (new) failed:', e);
    }
    setForceSetup(false);
  }

  if (!store.loaded) {
    return null;
  }

  if (forceSetup || (!store.active && !skipped)) {
    // «← Indietro» solo se un account c'è già: torna dove si stava.
    // «Guarda prima l'app» solo se non c'è: è la via d'uscita del primo
    // avvio, e con un account configurato non avrebbe senso.
    const canCancel = !!store.active;
    return (
      <AccountSetup
        onSaved={(acc) => {
          void persistNew(acc);
        }}
        {...(canCancel
          ? {}
          : {
              onSkip: () => {
                setSkipped(true);
                setForceSetup(false);
              },
            })}
        {...(canCancel
          ? {
              onCancel: () => {
                setForceSetup(false);
              },
            }
          : {})}
      />
    );
  }

  return (
    <AppShell
      account={store.active}
      onSwitchAccount={() => {
        setForceSetup(true);
      }}
    />
  );
}
