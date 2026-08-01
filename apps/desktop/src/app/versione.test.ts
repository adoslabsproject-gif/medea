/**
 * La versione è una sola, scritta in quattro posti.
 *
 * `package.json` della radice, quello dell'app, `tauri.conf.json` e
 * `Cargo.toml`. Se divergono, l'installatore prende il nome da uno e l'app
 * dichiara l'altro: un file che si chiama `Medea_0.1.0_x64-setup.exe` e che
 * una volta installato dice di essere la 0.0.0 è il modo più efficace per non
 * capire più quale versione ha in mano chi segnala un problema.
 *
 * Aggiornarne una e dimenticare le altre tre è esattamente il genere di
 * sbaglio che nessuno nota finché non serve.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const radice = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function leggi(percorso: string): string {
  return readFileSync(join(radice, percorso), 'utf8');
}

function versioneJson(percorso: string): string {
  const contenuto = JSON.parse(leggi(percorso)) as { version?: string };
  return contenuto.version ?? '';
}

describe('la versione', () => {
  const attesa = versioneJson('package.json');

  it('è dichiarata nella radice del workspace', () => {
    expect(attesa).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('combacia in package.json dell’app', () => {
    expect(versioneJson('apps/desktop/package.json')).toBe(attesa);
  });

  it('combacia in tauri.conf.json — è quella che nomina gli installatori', () => {
    expect(versioneJson('apps/desktop/src-tauri/tauri.conf.json')).toBe(attesa);
  });

  it('combacia in Cargo.toml — è quella che l’app dichiara di sé', () => {
    const cargo = /^version = "([^"]+)"/m.exec(leggi('apps/desktop/src-tauri/Cargo.toml'));
    expect(cargo?.[1]).toBe(attesa);
  });
});
