/**
 * Test catalog-spec — la FONTE DI VERITÀ condivisa. Se questa normalizzazione
 * sbaglia, sia la grammatica guided_json sia il validatore sbagliano insieme:
 * qui i test sono bug-bounty (mappatura tipi, secret, multi-azione, union).
 */
import { describe, it, expect } from 'vitest';
import { buildNodeConfigSpec, buildCatalogSpec, isExpressionValue } from './catalog-spec.js';
import type { NodeCatalogEntry } from './node-catalog.js';

function entry(partial: Partial<NodeCatalogEntry> & { defId: string }): NodeCatalogEntry {
  return {
    defId: partial.defId,
    type: partial.type ?? 'action',
    label: partial.label ?? 'L',
    description: partial.description ?? '',
    fields: partial.fields ?? [],
    ...(partial.actions ? { actions: partial.actions } : {}),
  };
}

function field(key: string, type: string, extra: Partial<NodeCatalogEntry['fields'][number]> = {}) {
  return { key, label: key, type, required: false, ...extra };
}

describe('buildNodeConfigSpec — mappatura tipi → kind', () => {
  it.each([
    ['text', 'string'],
    ['textarea', 'string'],
    ['secret', 'string'],
    ['code', 'string'],
    ['file-picker', 'string'],
    ['cron-builder', 'string'],
    ['db-table-picker', 'string'],
    ['number', 'number'],
    ['boolean', 'boolean'],
    ['json', 'structured'],
    ['key-value', 'structured'],
    ['filter-rows', 'structured'],
    ['form-fields', 'structured'],
    ['condition-rules', 'structured'],
  ])('tipo %s → kind %s', (type, kind) => {
    const spec = buildNodeConfigSpec(entry({ defId: 'n', fields: [field('k', type)] }));
    expect(spec.keys.get('k')!.kind).toBe(kind);
  });

  it('select CON options → enum (+ options copiati)', () => {
    const spec = buildNodeConfigSpec(
      entry({ defId: 'n', fields: [field('mode', 'select', { options: ['a', 'b'] })] }),
    );
    expect(spec.keys.get('mode')!.kind).toBe('enum');
    expect(spec.keys.get('mode')!.options).toEqual(['a', 'b']);
  });

  it('select SENZA options → string (no enum vuoto che bloccherebbe tutto)', () => {
    const spec = buildNodeConfigSpec(entry({ defId: 'n', fields: [field('mode', 'select')] }));
    expect(spec.keys.get('mode')!.kind).toBe('string');
    expect(spec.keys.get('mode')!.options).toBeUndefined();
  });

  it('tipo SCONOSCIUTO → structured (difensivo, non vincola a un tipo sbagliato)', () => {
    const spec = buildNodeConfigSpec(
      entry({ defId: 'n', fields: [field('x', 'some-future-type')] }),
    );
    expect(spec.keys.get('x')!.kind).toBe('structured');
  });
});

describe('buildNodeConfigSpec — secret & required', () => {
  it('🚨 secret → secret:true e required SEMPRE false (pending, mai forzato)', () => {
    const spec = buildNodeConfigSpec(
      entry({ defId: 'n', fields: [field('apiKey', 'secret', { required: true })] }),
    );
    const k = spec.keys.get('apiKey')!;
    expect(k.secret).toBe(true);
    expect(k.required).toBe(false);
  });

  it('campo required non-secret → required:true', () => {
    const spec = buildNodeConfigSpec(
      entry({ defId: 'n', fields: [field('url', 'text', { required: true })] }),
    );
    expect(spec.keys.get('url')!.required).toBe(true);
  });

  it('campo non-required → required:false', () => {
    const spec = buildNodeConfigSpec(entry({ defId: 'n', fields: [field('opt', 'text')] }));
    expect(spec.keys.get('opt')!.required).toBe(false);
  });
});

describe('buildNodeConfigSpec — defaultValue', () => {
  it("cattura defaultValue quando presente (per l'auto-config deterministica)", () => {
    const spec = buildNodeConfigSpec(
      entry({
        defId: 'n',
        fields: [field('method', 'select', { options: ['GET'], defaultValue: 'GET' })],
      }),
    );
    expect(spec.keys.get('method')!.defaultValue).toBe('GET');
  });

  it('assente/vuoto → defaultValue undefined (non stringa vuota)', () => {
    const spec = buildNodeConfigSpec(
      entry({ defId: 'n', fields: [field('a', 'text'), field('b', 'text', { defaultValue: '' })] }),
    );
    expect(spec.keys.get('a')!.defaultValue).toBeUndefined();
    expect(spec.keys.get('b')!.defaultValue).toBeUndefined();
  });
});

describe('buildNodeConfigSpec — multi-azione', () => {
  const multi = entry({
    defId: 'community_telegram',
    fields: [field('botToken', 'secret', { required: true })], // shared
    actions: [
      {
        id: 'send_message',
        label: 'Send',
        fields: [
          field('chatId', 'text', { required: true }),
          field('text', 'textarea', { required: true }),
        ],
      },
      { id: 'get_updates', label: 'Get', fields: [field('limit', 'number')] },
    ],
  });

  it('multiAction:true + actionIds = id delle action', () => {
    const spec = buildNodeConfigSpec(multi);
    expect(spec.multiAction).toBe(true);
    expect(spec.actionIds).toEqual(['send_message', 'get_updates']);
  });

  it('🚨 union dei campi: shared + tutti i campi di tutte le action', () => {
    const spec = buildNodeConfigSpec(multi);
    expect([...spec.keys.keys()].sort()).toEqual(['botToken', 'chatId', 'limit', 'text'].sort());
  });

  it('🚨 i campi delle action NON sono required (non sappiamo quale action verrà scelta)', () => {
    const spec = buildNodeConfigSpec(multi);
    expect(spec.keys.get('chatId')!.required).toBe(false);
    expect(spec.keys.get('text')!.required).toBe(false);
  });

  it('shared field ha precedenza sul campo action con stessa key (no downgrade required)', () => {
    const collide = entry({
      defId: 'n',
      fields: [field('mode', 'text', { required: true })],
      actions: [{ id: 'a1', label: 'A', fields: [field('mode', 'text')] }],
    });
    const spec = buildNodeConfigSpec(collide);
    expect(spec.keys.get('mode')!.required).toBe(true); // shared vince
  });

  it('nodo senza action → multiAction:false, niente actionIds', () => {
    const spec = buildNodeConfigSpec(entry({ defId: 'n', fields: [field('x', 'text')] }));
    expect(spec.multiAction).toBe(false);
    expect(spec.actionIds).toBeUndefined();
  });
});

describe('buildCatalogSpec — indicizzazione', () => {
  it("indicizza per defId; defId duplicato → vince l'ultimo (allineato a de-dup catalog)", () => {
    const spec = buildCatalogSpec([
      entry({ defId: 'dup', fields: [field('a', 'text')] }),
      entry({ defId: 'dup', fields: [field('b', 'number')] }),
    ]);
    expect(spec.size).toBe(1);
    expect([...spec.get('dup')!.keys.keys()]).toEqual(['b']);
  });
});

describe('isExpressionValue', () => {
  it.each(['{{ $json.x }}', 'prefisso {{ vars.y }} suffisso', '{{secrets.K}}'])(
    '%s → true',
    (v) => {
      expect(isExpressionValue(v)).toBe(true);
    },
  );
  it.each(['plain', '', '{{ incompleto', 'incompleto }}', 42, null, undefined, {}])(
    '%s → false',
    (v) => {
      expect(isExpressionValue(v)).toBe(false);
    },
  );
});
