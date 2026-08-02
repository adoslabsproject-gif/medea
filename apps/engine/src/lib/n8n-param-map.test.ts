/**
 * Bug-bounty test — param-mapper n8n → config FlowForge.
 *
 * Verifica che ogni mapper produca i campi config REALI del nodo target (non i nomi
 * n8n), normalizzi i valori (method uppercase), estragga il codice/cron dalle forme
 * n8n, e segnali ONESTAMENTE ciò che non è mappabile (auth, header, schedule, Set/IF).
 */
import { describe, it, expect } from 'vitest';
import { mapN8nParams } from './n8n-param-map.js';

describe('mapN8nParams — HTTP Request → action_http', () => {
  it('method (uppercase) + url + jsonBody → body/bodyType', () => {
    const r = mapN8nParams('action_http', {
      method: 'post',
      url: 'https://api.com',
      jsonBody: '{"a":1}',
    });
    expect(r.config).toMatchObject({
      method: 'POST',
      url: 'https://api.com',
      bodyType: 'json',
      body: '{"a":1}',
    });
  });

  it('default method GET se assente; requestMethod (n8n vecchio) supportato', () => {
    expect(mapN8nParams('action_http', { url: 'x' }).config.method).toBe('GET');
    expect(mapN8nParams('action_http', { requestMethod: 'delete', url: 'x' }).config.method).toBe(
      'DELETE',
    );
  });

  it('param n8n non pertinente (timeout) NON finisce nel config', () => {
    expect(
      mapN8nParams('action_http', { url: 'x', timeout: 30000 }).config.timeout,
    ).toBeUndefined();
  });

  it('ONESTÀ: auth + header n8n → warning (non mappati)', () => {
    const r = mapN8nParams('action_http', {
      url: 'x',
      authentication: 'genericCredentialType',
      sendHeaders: true,
    });
    expect(r.warnings.some((w) => w.includes('autenticazione'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('header'))).toBe(true);
  });

  it('auth=none → nessun warning auth', () => {
    expect(mapN8nParams('action_http', { url: 'x', authentication: 'none' }).warnings).toHaveLength(
      0,
    );
  });
});

describe('mapN8nParams — Code → action_run_js / action_run_python', () => {
  it('jsCode → code (+ warning di adattamento sintassi)', () => {
    const r = mapN8nParams('action_run_js', { jsCode: 'return items' });
    expect(r.config.code).toBe('return items');
    expect(r.warnings).toHaveLength(1);
  });

  it('functionCode (Function node vecchio) → code', () => {
    expect(mapN8nParams('action_run_js', { functionCode: 'x=1' }).config.code).toBe('x=1');
  });

  it('codice vuoto → config vuoto, nessun warning', () => {
    expect(mapN8nParams('action_run_js', {}).config).toEqual({});
    expect(mapN8nParams('action_run_js', {}).warnings).toHaveLength(0);
  });

  it('pythonCode → action_run_python.code', () => {
    expect(mapN8nParams('action_run_python', { pythonCode: 'print(1)' }).config.code).toBe(
      'print(1)',
    );
  });
});

describe('mapN8nParams — Webhook → trigger_webhook', () => {
  it('httpMethod → method (uppercase); path → customPath', () => {
    const r = mapN8nParams('trigger_webhook', { httpMethod: 'post', path: 'my-hook' });
    expect(r.config).toMatchObject({ method: 'POST', customPath: 'my-hook' });
  });

  it('default method POST; path assente → customPath assente', () => {
    const r = mapN8nParams('trigger_webhook', {});
    expect(r.config.method).toBe('POST');
    expect(r.config.customPath).toBeUndefined();
  });
});

describe('mapN8nParams — Cron/Schedule → trigger_cron', () => {
  it('cronExpression diretto → cronExpression', () => {
    expect(
      mapN8nParams('trigger_cron', { cronExpression: '0 9 * * 1' }).config.cronExpression,
    ).toBe('0 9 * * 1');
  });

  it('triggerTimes.item[].cronExpression estratto', () => {
    const r = mapN8nParams('trigger_cron', {
      triggerTimes: { item: [{ mode: 'custom', cronExpression: '*/5 * * * *' }] },
    });
    expect(r.config.cronExpression).toBe('*/5 * * * *');
  });

  it('ONESTÀ: schedule rule/interval (non-cron) → default ogni ora + warning', () => {
    const r = mapN8nParams('trigger_cron', {
      rule: { interval: [{ field: 'hours', hoursInterval: 2 }] },
    });
    expect(r.config.cronExpression).toBe('0 * * * *');
    expect(r.warnings.some((w) => w.includes('da rivedere'))).toBe(true);
  });
});

describe('mapN8nParams — tipi PASSTHROUGH (struttura n8n complessa)', () => {
  it('Set/logic_transform → param RAW stringificati + warning', () => {
    const r = mapN8nParams('logic_transform', { values: { string: [{ name: 'a', value: '1' }] } });
    expect(r.config.values).toBe('{"string":[{"name":"a","value":"1"}]}');
    expect(r.warnings.some((w) => w.includes('Set'))).toBe(true);
  });

  it('IF/logic_if e Switch/logic_switch → warning di review', () => {
    expect(
      mapN8nParams('logic_if', { conditions: {} }).warnings.some((w) => w.includes('IF')),
    ).toBe(true);
    expect(
      mapN8nParams('logic_switch', { rules: {} }).warnings.some((w) => w.includes('Switch')),
    ).toBe(true);
  });

  it('defId sconosciuto → passthrough raw, nessun warning', () => {
    const r = mapN8nParams('action_http_unknown_xyz', { foo: 'bar', n: 5 });
    expect(r.config).toEqual({ foo: 'bar', n: '5' });
    expect(r.warnings).toHaveLength(0);
  });
});
