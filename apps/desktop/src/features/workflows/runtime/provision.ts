/**
 * Consegnare al runtime quello che gli serve per eseguire davvero.
 *
 * Un workflow che dice `{{secrets.API_KEY}}` o che manda una email con
 * l'account configurato non funziona per magia: il runtime ha un suo
 * archivio, e finché nessuno ci mette dentro niente quelle espressioni si
 * risolvono nel vuoto e `action_send_email` non trova l'account.
 *
 * Il trasferimento avviene **all'apertura della sessione**, non a ogni
 * chiamata: sono dati che cambiano di rado, e ripeterli a ogni esecuzione
 * vorrebbe dire scrivere password nel database del runtime cento volte al
 * giorno per niente.
 */

import { loadAccounts } from '../../mail/store/account-store';
import type { MailAccount } from '../../mail/types';

import { runtimeApi } from './client';
import { allSecrets } from './secrets';

export interface ProvisionReport {
  secrets: number;
  accounts: number;
  /** Cosa non è riuscito, in parole. Non blocca il resto. */
  problems: string[];
}

interface RuntimeAccount {
  id: string;
  label: string;
}

/** Il livello di sicurezza SMTP nella forma che usa il runtime. */
function security(account: MailAccount): 'tls' | 'starttls' | 'plain' {
  if (account.smtp.implicitTls) return 'tls';
  return account.smtp.port === 25 ? 'plain' : 'starttls';
}

function toRuntimeAccount(account: MailAccount) {
  return {
    label: account.displayName || account.emailAddress,
    fromAddress: account.emailAddress,
    isDefault: false,
    smtp: {
      host: account.smtp.host,
      port: account.smtp.port,
      security: security(account),
      username: account.smtp.username,
      password: account.smtp.password,
    },
    imap: {
      host: account.imap.host,
      port: account.imap.port,
      username: account.imap.username,
      password: account.imap.password,
    },
  };
}

/**
 * Porta segreti e account di posta dentro il runtime.
 *
 * Un fallimento su un pezzo non ferma gli altri: se un account ha l'host
 * sbagliato è meglio avere i segreti caricati e un avviso, che non avere
 * niente.
 */
export async function provisionRuntime(): Promise<ProvisionReport> {
  const problems: string[] = [];
  let secretCount = 0;
  let accountCount = 0;

  // ── Segreti: dal portachiavi alle variabili del runtime ────────────────
  try {
    const secrets = await allSecrets();
    for (const [name, value] of Object.entries(secrets)) {
      try {
        await runtimeApi.put(`/variables/${encodeURIComponent(name)}`, { value });
        secretCount++;
      } catch (e) {
        problems.push(`segreto ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    problems.push(`portachiavi: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Account di posta: quelli di Medea diventano quelli del runtime ─────
  try {
    const { accounts } = await loadAccounts();
    if (accounts.length > 0) {
      // Si guarda cosa c'è già per non creare un doppione a ogni avvio: il
      // riconoscimento è sull'indirizzo, che è ciò che identifica l'account.
      const existing = await runtimeApi
        .get<{ accounts: RuntimeAccount[] }>('/system-email-accounts')
        .catch(() => ({ accounts: [] as RuntimeAccount[] }));
      const byLabel = new Map(existing.accounts.map((a) => [a.label, a.id]));

      for (const account of accounts) {
        const body = toRuntimeAccount(account);
        try {
          const known = byLabel.get(body.label);
          if (known) await runtimeApi.put(`/system-email-accounts/${known}`, body);
          else await runtimeApi.post('/system-email-accounts', body);
          accountCount++;
        } catch (e) {
          problems.push(
            `account ${account.emailAddress}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  } catch (e) {
    problems.push(`account di posta: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { secrets: secretCount, accounts: accountCount, problems };
}
