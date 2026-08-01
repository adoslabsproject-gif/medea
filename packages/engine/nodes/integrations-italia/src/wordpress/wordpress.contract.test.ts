/**
 * Contract test ANTI-DRIFT — italia_wordpress.
 *
 * Storia (review nodi): `outputs` dichiarava `totalPages` ma l'executor lo SCARTAVA
 * (wpFetch ignorava l'header X-WP-TotalPages). RISOLTO IMPLEMENTANDO l'estrazione e
 * l'esposizione nel ramo list. Questo guard verifica che gli output dichiarati siano
 * coerenti con le action e che le resource/action citate esistano davvero.
 */
import { describe, it, expect } from 'vitest';
import { wordpressNode } from './index.js';

const def = wordpressNode.def;

function options(key: string): readonly string[] {
  const f = def.configFields?.find((x) => x.key === key);
  return f?.type === 'select' ? f.options : [];
}

describe('italia_wordpress — contract (anti-drift)', () => {
  it('🚨 outputs dichiara totalPages (ora prodotto nel list) + result', () => {
    expect(def.outputs).toContain('result');
    expect(def.outputs).toContain('totalPages');
  });

  it('🚨 le action citate ⊆ enum reale', () => {
    expect([...options('action')].sort()).toEqual(
      ['create', 'delete', 'get', 'list', 'update', 'upload_media'],
    );
  });

  it('Application Password documentata (auth reale), non OAuth/JWT', () => {
    expect(def.description ?? '').toMatch(/Application Password/i);
  });
});
