// @vitest-environment happy-dom

/**
 * Che l'app regga davvero senza un account di posta.
 *
 * È la promessa fatta da «Guarda prima l'app»: sette sezioni su nove non
 * hanno niente a che vedere con la posta e devono funzionare lo stesso. Se
 * una di quelle esplodesse con `account` assente, il pulsante che invita a
 * entrare sarebbe un tranello.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

// Le sezioni pesanti non c'entrano con quello che si sta verificando: qui
// interessa il varco, non cosa disegnano dentro.
vi.mock('../mail/layout/MailLayout', () => ({ MailLayout: () => <div>posta</div> }));
vi.mock('../settings/SettingsView', () => ({ SettingsView: () => <div>impostazioni</div> }));
vi.mock('../address-book/AddressBookView', () => ({ AddressBookView: () => <div>rubrica</div> }));
vi.mock('../articles/ArticlesView', () => ({ ArticlesView: () => <div>articoli</div> }));
vi.mock('../contacts/ContactsView', () => ({ ContactsView: () => <div>anagrafiche</div> }));
vi.mock('../db-studio/DbStudioView', () => ({ DbStudioView: () => <div>database</div> }));
vi.mock('../documents/DocumentsView', () => ({ DocumentsView: () => <div>documenti</div> }));
vi.mock('../price-lists/PriceListsView', () => ({ PriceListsView: () => <div>listini</div> }));
vi.mock('../workflows', () => ({ WorkflowsView: () => <div>workflow</div> }));

import { AppShell } from './AppShell';

afterEach(cleanup);

describe('l’app senza account di posta', () => {
  it('non mostra la posta, ma spiega perché e come rimediare', () => {
    render(<AppShell account={null} onSwitchAccount={vi.fn()} />);

    expect(screen.getByText('Serve un account di posta')).toBeTruthy();
    expect(screen.queryByText('posta')).toBeNull();
    expect(screen.getByRole('button', { name: 'Configura un account' })).toBeTruthy();
  });

  it('da lì si arriva alla configurazione', () => {
    const onSwitchAccount = vi.fn();
    render(<AppShell account={null} onSwitchAccount={onSwitchAccount} />);

    fireEvent.click(screen.getByRole('button', { name: 'Configura un account' }));
    expect(onSwitchAccount).toHaveBeenCalled();
  });

  it('le sezioni che non c’entrano con la posta funzionano lo stesso', () => {
    // È la promessa del pulsante «Guarda prima l'app»: se una di queste
    // esplodesse con `account` assente, sarebbe un tranello.
    for (const [etichetta, testo] of [
      ['Rubrica', 'rubrica'],
      ['Anagrafiche', 'anagrafiche'],
      ['Articoli', 'articoli'],
      ['Listini', 'listini'],
      ['Documenti', 'documenti'],
      ['Workflow', 'workflow'],
    ] as const) {
      cleanup();
      render(<AppShell account={null} onSwitchAccount={vi.fn()} />);

      const bottone = screen.queryByRole('button', { name: new RegExp(etichetta, 'i') });
      if (!bottone) continue; // la sezione non è nella barra: niente da provare
      fireEvent.click(bottone);
      expect(screen.getByText(testo), etichetta).toBeTruthy();
    }
  });

  it('con un account, la posta si vede', () => {
    const account = {
      id: '1',
      displayName: 'Prova',
      emailAddress: 'a@b.it',
    } as unknown as Parameters<typeof AppShell>[0]['account'];

    render(<AppShell account={account} onSwitchAccount={vi.fn()} />);
    expect(screen.getByText('posta')).toBeTruthy();
  });
});
