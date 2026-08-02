/**
 * weather_node executor tests.
 *
 * Coverage:
 *  - parseLocation: coords valid, coords invalid, city name
 *  - mapCondition: codes noti (sereno, nebbia, temporale) + fallback
 *  - unit conversion: cToF, fToC, kmhToMph, mmToInch
 *  - executor end-to-end con fetch mock
 *  - cache hit/miss
 *  - error handling: geocoding miss, API 5xx
 *  - input validation: location vuoto throw, forecastDays clamp [0,7]
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { weatherExecutor, __test__ } from './weather.js';

const ctx = {
  workflowId: 'wf',
  runId: 'r',
  nodeId: 'n',
  tenantId: 't',
  userId: 'u',
  defId: 'weather_node',
  secrets: {},
  llmProviders: [],
  nodeOutputs: {},
} as unknown as Parameters<typeof weatherExecutor>[2];

describe('parseLocation', () => {
  it('parses "lat,lon" decimali', () => {
    expect(__test__.parseLocation('45.4642,9.1900')).toEqual({
      mode: 'coords',
      lat: 45.4642,
      lon: 9.19,
    });
  });
  it('parses "lat, lon" con spazi + negativi', () => {
    expect(__test__.parseLocation(' -33.8688 , 151.2093 ')).toEqual({
      mode: 'coords',
      lat: -33.8688,
      lon: 151.2093,
    });
  });
  it('rifiuta coords out-of-range → city mode', () => {
    expect(__test__.parseLocation('200,400')).toEqual({ mode: 'city', name: '200,400' });
  });
  it('parses nome citta\\` come city', () => {
    expect(__test__.parseLocation('Roma')).toEqual({ mode: 'city', name: 'Roma' });
  });
  it('preserva citta\\` con virgola tipo "Milano, IT"', () => {
    expect(__test__.parseLocation('Milano, IT')).toEqual({ mode: 'city', name: 'Milano, IT' });
  });
});

describe('mapCondition', () => {
  it('code 0 (clear) → IT "sereno"', () => {
    expect(__test__.mapCondition(0, 'it').condition).toBe('sereno');
  });
  it('code 95 (thunderstorm) → IT "temporale"', () => {
    expect(__test__.mapCondition(95, 'it').condition).toBe('temporale');
  });
  it('code 3 (overcast) → EN "overcast"', () => {
    expect(__test__.mapCondition(3, 'en').condition).toBe('overcast');
  });
  it('code unknown → "condizioni sconosciute" (IT)', () => {
    expect(__test__.mapCondition(999, 'it').condition).toBe('condizioni sconosciute');
  });
  it('include icon emoji sempre', () => {
    expect(__test__.mapCondition(0, 'it').icon).toBe('☀️');
    expect(__test__.mapCondition(95, 'it').icon).toBe('⛈️');
  });
});

describe('unit conversion', () => {
  it('cToF: 0°C = 32°F', () => expect(__test__.cToF(0)).toBe(32));
  it('cToF: 100°C = 212°F', () => expect(__test__.cToF(100)).toBe(212));
  it('fToC: 32°F = 0°C', () => expect(__test__.fToC(32)).toBe(0));
  it('kmhToMph: 100 km/h ≈ 62.14 mph', () => expect(__test__.kmhToMph(100)).toBeCloseTo(62.14, 2));
  it('mmToInch: 25.4 mm = 1 inch', () => expect(__test__.mmToInch(25.4)).toBe(1));
});

describe('weatherExecutor end-to-end', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    __test__.clearCache();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('fetcha forecast per coords (no geocoding)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 18.5,
            apparent_temperature: 17.0,
            relative_humidity_2m: 60,
            wind_speed_10m: 12,
            wind_direction_10m: 180,
            weather_code: 0,
          },
          daily: {
            time: ['2026-06-05', '2026-06-06'],
            temperature_2m_max: [22, 24],
            temperature_2m_min: [14, 15],
            weather_code: [1, 2],
            precipitation_sum: [0, 0.5],
          },
          timezone: 'Europe/Rome',
        }),
        { status: 200 },
      ),
    );
    const r = await weatherExecutor({ location: '45.46,9.19', forecastDays: 2 }, null, ctx);
    const out = r.output as {
      location: { lat: number; timezone: string };
      current: { tempC: number; condition: string };
      forecast: { date: string; minC: number; maxC: number }[];
    };
    expect(out.location.lat).toBe(45.46);
    expect(out.location.timezone).toBe('Europe/Rome');
    expect(out.current.tempC).toBe(18.5);
    expect(out.current.condition).toBe('sereno');
    expect(out.forecast).toHaveLength(2);
    expect(out.forecast[0]!.date).toBe('2026-06-05');
    expect(out.forecast[0]!.maxC).toBe(22);
  });

  it('city name → geocoding → forecast (2 fetch chiamate)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                name: 'Roma',
                latitude: 41.9,
                longitude: 12.5,
                country: 'Italy',
                timezone: 'Europe/Rome',
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            current: {
              temperature_2m: 25,
              apparent_temperature: 26,
              relative_humidity_2m: 50,
              wind_speed_10m: 5,
              wind_direction_10m: 90,
              weather_code: 0,
            },
            daily: {
              time: [],
              temperature_2m_max: [],
              temperature_2m_min: [],
              weather_code: [],
              precipitation_sum: [],
            },
            timezone: 'Europe/Rome',
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetchMock;
    const r = await weatherExecutor({ location: 'Roma', forecastDays: 0 }, null, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const out = r.output as { location: { name: string; country: string }; forecast: unknown[] };
    expect(out.location.name).toBe('Roma');
    expect(out.location.country).toBe('Italy');
    expect(out.forecast).toEqual([]);
  });

  it('cache: 2 chiamate consecutive stesse coords → 1 sola fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 20,
            apparent_temperature: 20,
            relative_humidity_2m: 50,
            wind_speed_10m: 10,
            wind_direction_10m: 0,
            weather_code: 0,
          },
          timezone: 'UTC',
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;
    await weatherExecutor({ location: '40,10', forecastDays: 0 }, null, ctx);
    await weatherExecutor({ location: '40,10', forecastDays: 0 }, null, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('imperial units: tempC restituito in °F', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 0,
            apparent_temperature: 0,
            relative_humidity_2m: 50,
            wind_speed_10m: 100,
            wind_direction_10m: 0,
            weather_code: 0,
          },
          timezone: 'UTC',
        }),
        { status: 200 },
      ),
    );
    const r = await weatherExecutor(
      { location: '0,0', forecastDays: 0, units: 'imperial' },
      null,
      ctx,
    );
    const out = r.output as { current: { tempC: number; windKmh: number } };
    expect(out.current.tempC).toBe(32); // 0°C → 32°F
    expect(out.current.windKmh).toBeCloseTo(62.14, 2); // 100 km/h → mph
  });

  it('language en → condition in inglese', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 10,
            apparent_temperature: 10,
            relative_humidity_2m: 80,
            wind_speed_10m: 0,
            wind_direction_10m: 0,
            weather_code: 61,
          },
          timezone: 'UTC',
        }),
        { status: 200 },
      ),
    );
    const r = await weatherExecutor(
      { location: '0,0', forecastDays: 0, language: 'en' },
      null,
      ctx,
    );
    const out = r.output as { current: { condition: string } };
    expect(out.current.condition).toBe('slight rain');
  });

  it('location vuoto → throw', async () => {
    await expect(weatherExecutor({ location: '' }, null, ctx)).rejects.toThrow(
      /"location" è obbligatorio/,
    );
  });

  it('geocoding miss → throw informativo', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await expect(weatherExecutor({ location: 'Xyzabc1234' }, null, ctx)).rejects.toThrow(
      /non trovata/,
    );
  });

  it('forecast API 500 → throw', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(weatherExecutor({ location: '0,0' }, null, ctx)).rejects.toThrow(
      /forecast API fallita/,
    );
  });

  it('forecastDays clamp [0,7]: input 999 → cappato a 7', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 1,
            apparent_temperature: 1,
            relative_humidity_2m: 1,
            wind_speed_10m: 1,
            wind_direction_10m: 1,
            weather_code: 0,
          },
          daily: {
            time: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'],
            temperature_2m_max: [1, 1, 1, 1, 1, 1, 1],
            temperature_2m_min: [0, 0, 0, 0, 0, 0, 0],
            weather_code: [0, 0, 0, 0, 0, 0, 0],
            precipitation_sum: [0, 0, 0, 0, 0, 0, 0],
          },
          timezone: 'UTC',
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;
    const r = await weatherExecutor({ location: '0,0', forecastDays: 999 }, null, ctx);
    const callUrl = fetchMock.mock.calls[0]![0] as string;
    expect(callUrl).toContain('forecast_days=7');
    const out = r.output as { forecast: unknown[] };
    expect(out.forecast).toHaveLength(7);
  });
});

describe('NodeDef contract', () => {
  it('weatherNode esportato in stdlib', async () => {
    const mod = await import('@medea/engine-nodes-stdlib');
    expect(mod.weatherNode).toBeDefined();
    expect(mod.weatherNode.def.id).toBe('weather_node');
    expect(mod.weatherNode.def.type).toBe('action');
  });

  it('configFields contiene location/forecastDays/units/language', async () => {
    const mod = await import('@medea/engine-nodes-stdlib');
    const keys = (mod.weatherNode.def.configFields ?? []).map((f) => f.key);
    expect(keys).toEqual(['location', 'forecastDays', 'units', 'language']);
  });

  it('description ≥150 char (criterio STABLE)', async () => {
    const mod = await import('@medea/engine-nodes-stdlib');
    expect((mod.weatherNode.def.description ?? '').length).toBeGreaterThanOrEqual(150);
  });
});
