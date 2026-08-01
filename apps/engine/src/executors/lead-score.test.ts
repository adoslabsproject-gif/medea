/**
 * Bug-bounty UNIT — executors/lead-score.ts (audit coverage 2026-06-12: 5%).
 * Service deterministico usato REALE (no mock): si pinna la validazione
 * dell'executor + la propagazione della config + le invarianti di scoring
 * (keyword pesate, country bonus IT/FR=+20 vs altro 2-letter=+10, clamp
 * 0-100, send_recommended = score>=threshold, custom profile JSON).
 */
import { describe, it, expect } from 'vitest';
import { leadScoreExecutor } from './lead-score.js';

const ctx = () => ({
  workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't', userId: 'u',
  defId: 'action_lead_score', secrets: {}, llmProviders: [], nodeOutputs: {},
}) as unknown as Parameters<typeof leadScoreExecutor>[2];

const run = (config: Record<string, unknown>) => leadScoreExecutor(config as never, null as never, ctx());
interface Out { score: number; category: string; country_bonus: number; send_recommended: boolean; matched_positive: unknown[] }
const out = async (config: Record<string, unknown>): Promise<Out> => ((await run(config)).output as Out);

describe('lead-score — validazione (l executor lancia SINCRONO prima del Promise)', () => {
  it('content mancante → throw', () => {
    expect(() => run({})).toThrow(/content è obbligatorio/);
  });

  it('profile=custom con JSON rotto → throw esplicito (non scoring silenzioso)', () => {
    expect(() => run({ content: 'x', profile: 'custom', customPositiveJson: '{rotto' }))
      .toThrow(/non parse-able/);
  });
});

describe('lead-score — scoring deterministico (service reale)', () => {
  it('keyword "bow thruster" presente → score positivo + categoria shipyard', async () => {
    const r = await out({ content: 'We install bow thruster systems for yachts', threshold: 50 });
    expect(r.score).toBeGreaterThan(0);
    expect(r.category).toBe('shipyard');
    expect(r.matched_positive.length).toBeGreaterThan(0);
  });

  it('country bonus: IT (high-priority) = +20, paese 2-letter generico = +10', async () => {
    const it = await out({ content: 'bow thruster', country: 'it', threshold: 0 });
    expect(it.country_bonus).toBe(20);
    const generic = await out({ content: 'bow thruster', country: 'JP', threshold: 0 });
    expect(generic.country_bonus).toBe(10);
    const none = await out({ content: 'bow thruster', threshold: 0 });
    expect(none.country_bonus).toBe(0);
  });

  it('send_recommended = score >= threshold (gate booleano)', async () => {
    const high = await out({ content: 'bow thruster stern thruster elica di prua', country: 'IT', threshold: 50 });
    expect(high.send_recommended).toBe(high.score >= 50);
    const blocked = await out({ content: 'bow thruster', country: 'IT', threshold: 99 });
    expect(blocked.send_recommended).toBe(false);
  });

  it('contenuto irrilevante → score basso, categoria unknown', async () => {
    const r = await out({ content: 'lorem ipsum dolor sit amet', threshold: 50 });
    expect(r.category).toBe('unknown');
    expect(r.send_recommended).toBe(false);
  });

  it('score clampato a [0,100] (mai negativo, mai >100)', async () => {
    const r = await out({ content: 'lorem ipsum '.repeat(50), threshold: 50 });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('profile=custom con keyword positive custom → applica i pesi forniti', async () => {
    const r = await out({
      content: 'super-widget super-widget',
      profile: 'custom', threshold: 0,
      customPositiveJson: JSON.stringify([{ keyword: 'super-widget', weight: 40, category: 'distributor' }]),
    });
    expect(r.score).toBeGreaterThan(0);
  });
});
