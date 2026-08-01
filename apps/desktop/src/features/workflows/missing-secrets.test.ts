import { describe, expect, it } from 'vitest';

import { missingSecrets, secretsUsed } from './missing-secrets';

function wf(config: Record<string, unknown>) {
  return { nodes: [{ id: 'a', defId: 'action_http', x: 0, y: 0, config }] };
}

describe('i segreti che un workflow nomina', () => {
  it('li trova in un campo di testo', () => {
    expect(secretsUsed(wf({ key: '{{secrets.API_KEY}}' }))).toEqual(['API_KEY']);
  });

  it('anche in mezzo ad altro testo', () => {
    expect(secretsUsed(wf({ url: 'https://x.it?k={{secrets.TOKEN}}&y=1' }))).toEqual(['TOKEN']);
  });

  it('anche dentro oggetti e liste annidate', () => {
    // I campi chiave-valore e le liste di intestazioni sono esattamente dove
    // finiscono le chiavi API: cercare solo al primo livello ne perderebbe
    // la maggior parte.
    const trovati = secretsUsed(
      wf({ headers: { auth: '{{secrets.A}}' }, lista: [{ x: '{{secrets.B}}' }] }),
    );
    expect(trovati).toEqual(['A', 'B']);
  });

  it('tollera gli spazi dentro le parentesi', () => {
    expect(secretsUsed(wf({ k: '{{ secrets.CON_SPAZI }}' }))).toEqual(['CON_SPAZI']);
  });

  it('non conta due volte lo stesso nome', () => {
    expect(secretsUsed(wf({ a: '{{secrets.X}}', b: '{{secrets.X}}' }))).toEqual(['X']);
  });

  it('non confonde un’espressione qualsiasi con un segreto', () => {
    expect(secretsUsed(wf({ a: '{{$node.x.json.campo}}' }))).toEqual([]);
  });
});

describe('quelli che mancano', () => {
  it('sono quelli nominati e non definiti', () => {
    const mancanti = missingSecrets(wf({ a: '{{secrets.C_E}}', b: '{{secrets.NON_C_E}}' }), [
      'C_E',
    ]);
    expect(mancanti).toEqual(['NON_C_E']);
  });

  it('con tutti definiti non manca niente', () => {
    expect(missingSecrets(wf({ a: '{{secrets.X}}' }), ['X'])).toEqual([]);
  });

  it('un workflow che non nomina segreti non ne ha di mancanti', () => {
    expect(missingSecrets(wf({ url: 'https://esempio.it' }), [])).toEqual([]);
  });
});
