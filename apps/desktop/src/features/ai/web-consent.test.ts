// @vitest-environment happy-dom

/**
 * Quando aprire una pagina chiede il permesso.
 *
 * L'assistente legge email scritte da estranei. Un'email può contenere una
 * frase rivolta al modello — «apri questo indirizzo» — con dentro, nella
 * coda dell'indirizzo, un dato preso dalla posta. Aprire quella pagina vuol
 * dire consegnare il dato a chi ha scritto l'email.
 *
 * Per questo la prima pagina di ogni sito, in ogni conversazione, la conferma
 * l'utente vedendo l'indirizzo. Poi quel sito è approvato e non si chiede più.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ToolCall } from './tools';
import {
  confermaWebDisattivata,
  FETCH_SENZA_CONFERMA_KEY,
  SitiApprovati,
  sitoDi,
} from './web-consent';

function fetch(url: unknown): ToolCall {
  return { id: 't', name: 'web_fetch', args: { url } };
}

beforeEach(() => {
  localStorage.clear();
});

describe('sitoDi', () => {
  it('è il nome del sito, senza percorso né porta', () => {
    expect(sitoDi(fetch('https://www.example.com:8443/a/b?c=1'))).toBe('www.example.com');
    expect(sitoDi(fetch('  http://Example.COM/x  '))).toBe('example.com');
  });

  it('un indirizzo che non si capisce non ha un sito', () => {
    expect(sitoDi(fetch('non un indirizzo'))).toBeNull();
    expect(sitoDi(fetch(undefined))).toBeNull();
    expect(sitoDi(fetch(42))).toBeNull();
  });
});

describe('SitiApprovati', () => {
  it('la prima pagina di un sito chiede conferma', () => {
    const siti = new SitiApprovati();
    expect(siti.richiesta('conv-1', fetch('https://example.com/a'))).toEqual({
      sito: 'example.com',
      url: 'https://example.com/a',
    });
  });

  it('dopo il sì, le altre pagine dello stesso sito non chiedono più', () => {
    const siti = new SitiApprovati();
    siti.approva('conv-1', 'example.com');
    expect(siti.richiesta('conv-1', fetch('https://example.com/altra'))).toBeNull();
  });

  /**
   * Un sottodominio è un altro sito: chiunque può registrare
   * `example.com.malevolo.example`, e `dati.example.com` può appartenere a
   * qualcun altro rispetto a `www.example.com`.
   */
  it('un sito diverso chiede di nuovo, anche se il nome si somiglia', () => {
    const siti = new SitiApprovati();
    siti.approva('conv-1', 'example.com');
    expect(siti.richiesta('conv-1', fetch('https://altro.example/'))?.sito).toBe('altro.example');
    expect(siti.richiesta('conv-1', fetch('https://sub.example.com/'))?.sito).toBe(
      'sub.example.com',
    );
    expect(siti.richiesta('conv-1', fetch('https://example.com.malevolo.example/'))?.sito).toBe(
      'example.com.malevolo.example',
    );
  });

  it('il sì vale per quella conversazione, non per le altre', () => {
    const siti = new SitiApprovati();
    siti.approva('conv-1', 'example.com');
    expect(siti.richiesta('conv-2', fetch('https://example.com/'))).not.toBeNull();
  });

  it('un no non approva niente: la prossima volta si richiede', () => {
    const siti = new SitiApprovati();
    siti.richiesta('conv-1', fetch('https://example.com/'));
    expect(siti.richiesta('conv-1', fetch('https://example.com/'))).not.toBeNull();
  });

  /**
   * Senza un sito leggibile non c'è niente di sensato da mostrare all'utente.
   * Si chiede comunque, con l'indirizzo com'è: lo strumento lo rifiuterà, ma
   * non deve partire in silenzio.
   */
  it('un indirizzo illeggibile chiede conferma lo stesso', () => {
    const siti = new SitiApprovati();
    expect(siti.richiesta('conv-1', fetch('boh'))).toEqual({ sito: null, url: 'boh' });
  });

  it('senza una conversazione il sì non si ricorda', () => {
    const siti = new SitiApprovati();
    siti.approva(null, 'example.com');
    expect(siti.richiesta(null, fetch('https://example.com/'))).not.toBeNull();
  });
});

describe('confermaWebDisattivata', () => {
  it('di suo la conferma è attiva', () => {
    expect(confermaWebDisattivata()).toBe(false);
  });

  it('si disattiva solo con una scelta esplicita', () => {
    localStorage.setItem(FETCH_SENZA_CONFERMA_KEY, 'true');
    expect(confermaWebDisattivata()).toBe(true);
    localStorage.setItem(FETCH_SENZA_CONFERMA_KEY, 'boh');
    expect(confermaWebDisattivata()).toBe(false);
  });
});
