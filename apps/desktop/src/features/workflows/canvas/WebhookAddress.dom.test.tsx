// @vitest-environment happy-dom

/**
 * Che l'indirizzo del webhook si veda, e che si dica che è locale.
 *
 * La seconda parte non è un dettaglio: un indirizzo `127.0.0.1` incollato
 * dentro la configurazione di un servizio esterno non funzionerà mai, e chi
 * lo fa scoprirà il perché dopo mezz'ora di prove.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime', () => ({ webhookAddress: vi.fn() }));

import * as runtime from '../runtime';

import { WebhookAddress } from './WebhookAddress';

const webhookAddress = vi.mocked(runtime.webhookAddress);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('l’indirizzo del webhook', () => {
  it('spiega perché non c’è, se il motore non conosce ancora il workflow', () => {
    render(<WebhookAddress runtimeId={undefined} />);
    expect(screen.getByText(/dopo la prima esecuzione/)).toBeTruthy();
    expect(webhookAddress).not.toHaveBeenCalled();
  });

  it('mostra l’indirizzo e avvisa che è locale', async () => {
    webhookAddress.mockResolvedValue({
      url: 'http://127.0.0.1:39100/webhooks/abc/def',
      authMode: 'none',
    });

    render(<WebhookAddress runtimeId="abc" />);

    await waitFor(() => {
      expect(screen.getByText('http://127.0.0.1:39100/webhooks/abc/def')).toBeTruthy();
    });
    expect(screen.getByText(/non da internet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copia' })).toBeTruthy();
  });

  it('non mostra niente quando un indirizzo non c’è', async () => {
    // Un workflow senza nodo webhook, o un segreto mancante: in nessuno dei
    // due casi ha senso un errore rosso dentro un pannello di configurazione.
    webhookAddress.mockResolvedValue(null);

    const { container } = render(<WebhookAddress runtimeId="abc" />);
    await waitFor(() => {
      expect(webhookAddress).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
