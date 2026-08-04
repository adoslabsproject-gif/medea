import { useEffect, useRef, useState } from 'react';

import { AccountSetup } from '../features/account-setup';
import { mailApi } from '../features/mail/api';
import { useAccountStore } from '../features/mail/store/account-store';
import type { MailAccount } from '../features/mail/types';
import { useReminderNotifications } from '../features/reminders/useReminderNotifications';
import { AppShell } from '../features/shell';
import { useAutonomousRuns } from '../features/workflows';

import { PortachiaviBloccato } from './PortachiaviBloccato';
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
      // Ripara anche gli id già disallineati: se il portachiavi contiene un
      // account il cui id nel database non esiste — succedeva riconfigurando
      // un indirizzo già presente — il database restituisce l'id buono e lo
      // si riscrive. Senza questo, chi ci è già passato resta rotto per
      // sempre, perché ogni cartella continua a cercare una riga che non c'è.
      let corretti = false;
      const allineati = [...store.accounts];
      for (const [i, acc] of allineati.entries()) {
        try {
          const idVero = await mailApi.db.accountUpsert(acc);
          if (idVero !== acc.id) {
            allineati[i] = { ...acc, id: idVero };
            corretti = true;
          }
        } catch (e) {
          console.error(`Registrazione dell'account ${acc.id} fallita:`, e);
        }
      }
      if (corretti) await store.replaceAll(allineati);
    })();
  }, [store.loaded, store.accounts, store]);

  async function persistNew(acc: MailAccount) {
    // Prima il database, poi il portachiavi: è il database a decidere l'id
    // vero. Riconfigurare un indirizzo già presente non crea una seconda riga
    // — si tiene quella vecchia, con la posta che ci sta appesa — e l'id che
    // torna è il suo. Salvare nel portachiavi l'id inventato dalla schermata
    // di setup significherebbe puntare a una riga che non esiste, e ogni
    // cartella fallirebbe con «FOREIGN KEY constraint failed».
    let daSalvare = acc;
    try {
      const idVero = await mailApi.db.accountUpsert(acc);
      if (idVero !== acc.id) daSalvare = { ...acc, id: idVero };
    } catch (e) {
      console.error('Registrazione account nel database fallita:', e);
    }
    await store.addAccount(daSalvare);
    setForceSetup(false);
  }

  if (!store.loaded) {
    return null;
  }

  // Il portachiavi non ha risposto: gli account potrebbero esserci tutti. La
  // schermata di configurazione qui è la cosa peggiore che si possa mostrare,
  // perché invita a reinserire credenziali che esistono già — e un secondo
  // account per lo stesso indirizzo il database non lo accetta, così la posta
  // smette di caricarsi del tutto. Chiedere di riprovare non perde niente.
  if (store.illeggibile && !forceSetup) {
    return <PortachiaviBloccato onRiprova={() => void store.refresh()} />;
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
