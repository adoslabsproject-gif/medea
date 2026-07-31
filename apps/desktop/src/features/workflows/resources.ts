/**
 * Le risorse reali di Medea, offerte ai nodi che ne hanno bisogno.
 *
 * È la differenza fra l'editor dentro il client di posta e quello sul
 * server: là un nodo email chiede host, porta, utente e password, qui gli
 * account ci sono già — configurati, con le credenziali nel portachiavi e la
 * posta già scaricata. Chiedere di nuovo quello che il programma sa sarebbe
 * assurdo.
 *
 * Nel documento resta salvato **l'identificativo dell'account**, che è la
 * stessa forma che usa FlowForge: un workflow esportato non diventa
 * incompatibile, semplicemente sul server quell'id andrà rimappato.
 */

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/** Un account di posta come lo conosce il database locale. */
export interface MailAccountRef {
  id: string;
  displayName: string;
  emailAddress: string;
}

interface StoredAccount {
  id: string;
  displayName: string;
  emailAddress: string;
}

export async function listMailAccounts(): Promise<MailAccountRef[]> {
  const rows = await invoke<StoredAccount[]>('db_account_list');
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    emailAddress: r.emailAddress,
  }));
}

/**
 * Gli account, caricati una volta per pannello.
 *
 * Un errore non blocca la configurazione del nodo: si torna alla casella di
 * testo, che è sempre meglio di un campo che non si può compilare.
 */
export function useMailAccounts(): { accounts: MailAccountRef[]; failed: boolean } {
  const [accounts, setAccounts] = useState<MailAccountRef[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void listMailAccounts()
      .then((list) => {
        if (alive) setAccounts(list);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { accounts, failed };
}
