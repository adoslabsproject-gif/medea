/**
 * Test 2026-grade — contract NodeDef per i 4 trigger built-in stdlib
 * (manual, cron, webhook, form). Sono nodi dichiarativi (no executor —
 * sono triggerati dal runtime), quindi il contract da verificare e\` puro
 * NodeDef shape + regola A3.3 description.
 *
 * Coverage:
 *  - shape NodeDef: id, type=trigger, label, icon, color, description, vendor, version
 *  - A3.3 contract: description >= 150 char, >= 25 word distinct, contiene "Use case"
 *  - id segue convenzione `trigger_<name>` (registrazione palette)
 *  - configFields tipizzati (key, label, type, required) quando presenti
 *  - vendor=flowforge per built-in
 *  - color verde standard (#22c55e) per categoria trigger nell'UI
 */
import { describe, it, expect } from 'vitest';
import { manualTriggerNode } from './manual.js';
import { cronTriggerNode } from './cron.js';
import { webhookTriggerNode } from './webhook.js';
import { formTriggerNode } from './form.js';
import type { NodeModule } from '../types.js';

const ALL_TRIGGERS: { name: string; node: NodeModule }[] = [
  { name: 'manual', node: manualTriggerNode },
  { name: 'cron', node: cronTriggerNode },
  { name: 'webhook', node: webhookTriggerNode },
  { name: 'form', node: formTriggerNode },
];

describe('trigger NodeDef shape contract', () => {
  it.each(ALL_TRIGGERS)('$name: ha tutti i campi mandatory NodeDef', ({ node }) => {
    expect(node.def).toBeDefined();
    expect(typeof node.def.id).toBe('string');
    expect(node.def.id).toMatch(/^trigger_[a-z_]+$/u);
    expect(node.def.type).toBe('trigger');
    expect(typeof node.def.label).toBe('string');
    expect(node.def.label.length).toBeGreaterThan(0);
    expect(typeof node.def.icon).toBe('string');
    expect(typeof node.def.color).toBe('string');
    expect(typeof node.def.description).toBe('string');
  });

  it.each(ALL_TRIGGERS)('$name: vendor=flowforge built-in', ({ node }) => {
    expect(node.def.vendor).toBe('flowforge');
  });

  it.each(ALL_TRIGGERS)('$name: version semver-like', ({ node }) => {
    expect(node.def.version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it.each(ALL_TRIGGERS)('$name: color verde categoria trigger #22c55e', ({ node }) => {
    expect(node.def.color).toBe('#22c55e');
  });
});

describe('🚨 A3.3 description contract (audit anti-placeholder)', () => {
  it.each(ALL_TRIGGERS)('$name: description >= 150 char (no placeholder smell)', ({ node }) => {
    expect(node.def.description.length).toBeGreaterThanOrEqual(150);
  });

  it.each(ALL_TRIGGERS)(
    '$name: >= 25 distinct word ≥3 char (no whitespace-stuffing)',
    ({ node }) => {
      const words = node.def.description
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3);
      const distinct = new Set(words);
      expect(distinct.size).toBeGreaterThanOrEqual(25);
    },
  );

  it.each(ALL_TRIGGERS)('$name: contiene "use case" (concretezza pragmatica)', ({ node }) => {
    expect(node.def.description.toLowerCase()).toContain('use case');
  });

  it.each(ALL_TRIGGERS)(
    '$name: NON inizia con verbo imperativo inglese (placeholder smell)',
    ({ node }) => {
      const firstWord = node.def.description.trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
      const ENGLISH_VERBS = [
        'triggers',
        'starts',
        'fires',
        'sends',
        'receives',
        'calls',
        'executes',
        'returns',
      ];
      expect(ENGLISH_VERBS).not.toContain(firstWord);
    },
  );
});

describe('🚨 cron trigger config fields', () => {
  const def = cronTriggerNode.def;
  const fields = def.configFields ?? [];

  it('id=trigger_cron + label "Schedule (Cron)"', () => {
    expect(def.id).toBe('trigger_cron');
    expect(def.label).toContain('Cron');
  });

  it('cronExpression field present + required', () => {
    const f = fields.find((x) => x.key === 'cronExpression');
    expect(f).toBeDefined();
    expect(f?.required).toBe(true);
    expect(f?.type).toBe('cron-builder');
  });

  it('cronExpression default = ore 9 weekdays "0 9 * * 1-5"', () => {
    const f = fields.find((x) => x.key === 'cronExpression');
    expect(f?.defaultValue).toBe('0 9 * * 1-5');
  });

  it('timezone field + default Europe/Rome (business IT)', () => {
    const f = fields.find((x) => x.key === 'timezone');
    expect(f).toBeDefined();
    expect(f?.defaultValue).toBe('Europe/Rome');
    expect(f?.type).toBe('timezone-picker');
  });
});

describe('🚨 webhook trigger config fields', () => {
  const def = webhookTriggerNode.def;
  const fields = def.configFields ?? [];

  it('id=trigger_webhook + tipo=trigger', () => {
    expect(def.id).toBe('trigger_webhook');
    expect(def.type).toBe('trigger');
  });

  it('method field present con OPTIONS HTTP standard', () => {
    const f = fields.find((x) => x.key === 'method');
    expect(f).toBeDefined();
    expect(f?.type).toBe('select');
    expect(f?.options).toEqual(expect.arrayContaining(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']));
  });

  it('method default = POST (caso comune)', () => {
    const f = fields.find((x) => x.key === 'method');
    expect(f?.defaultValue).toBe('POST');
  });

  it('customPath field present (per URL leggibili)', () => {
    const f = fields.find((x) => x.key === 'customPath');
    expect(f).toBeDefined();
  });

  it('description mentions HMAC + Stripe (production auth pattern)', () => {
    expect(def.description.toLowerCase()).toContain('hmac');
    expect(def.description).toContain('Stripe');
  });
});

describe('🚨 form trigger config', () => {
  const def = formTriggerNode.def;

  it('id=trigger_form + tipo=trigger', () => {
    expect(def.id).toBe('trigger_form');
    expect(def.type).toBe('trigger');
  });

  it('description menziona form fields o submit (semantica chiara)', () => {
    expect(def.description.toLowerCase()).toMatch(/form|submit|campo/u);
  });
});

describe('🚨 manual trigger', () => {
  const def = manualTriggerNode.def;

  it('id=trigger_manual', () => {
    expect(def.id).toBe('trigger_manual');
  });

  it('NO configFields (dichiarativo puro, no input)', () => {
    expect(def.configFields).toBeUndefined();
  });

  it('description: menziona ciclo developer/dry-run (semantica corretta)', () => {
    expect(def.description.toLowerCase()).toMatch(/test|debug|sviluppo|developer|dry-run/u);
  });
});

describe('🚨 ID uniqueness across triggers', () => {
  it('tutti i 4 trigger hanno id distinti (no duplicati registry collision)', () => {
    const ids = ALL_TRIGGERS.map((t) => t.node.def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
