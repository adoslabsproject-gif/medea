import { useState } from 'react';

import { AddressBookView } from '../address-book/AddressBookView';
import { ArticlesView } from '../articles/ArticlesView';
import { ContactsView } from '../contacts/ContactsView';
import { DbStudioView } from '../db-studio/DbStudioView';
import { DocumentsView } from '../documents/DocumentsView';
import { MailLayout } from '../mail/layout/MailLayout';
import type { MailAccount } from '../mail/types';
import { PriceListsView } from '../price-lists/PriceListsView';
import { SettingsView } from '../settings/SettingsView';
import { WorkflowsView } from '../workflows';

import { ActivityRail, type SectionId } from './ActivityRail';
import styles from './AppShell.module.css';
import { NoAccount } from './NoAccount';

interface Props {
  /** Assente quando si è scelto di guardare l'app senza configurare la posta. */
  account: MailAccount | null;
  onSwitchAccount: () => void;
}

export function AppShell({ account, onSwitchAccount }: Props) {
  const [active, setActive] = useState<SectionId>('mail');

  return (
    <div className={styles.root}>
      <ActivityRail active={active} onSelect={setActive} />
      <div className={styles.workspace}>
        {active === 'mail' &&
          (account ? (
            <MailLayout account={account} onSwitchAccount={onSwitchAccount} />
          ) : (
            <NoAccount what="La posta" onConfigure={onSwitchAccount} />
          ))}
        {active === 'address-book' && <AddressBookView />}
        {active === 'contacts' && <ContactsView />}
        {active === 'articles' && <ArticlesView />}
        {active === 'price-lists' && <PriceListsView />}
        {active === 'documents' && <DocumentsView />}
        {active === 'db-studio' && <DbStudioView />}
        {active === 'workflows' && <WorkflowsView />}
        {active === 'settings' &&
          (account ? (
            <SettingsView account={account} />
          ) : (
            <NoAccount what="Quello che c'è da impostare" onConfigure={onSwitchAccount} />
          ))}
      </div>
    </div>
  );
}
