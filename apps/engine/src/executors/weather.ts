/**
 * `weather_node` — executor.
 *
 * Pipeline:
 *   1. Parse `location` config → coords or city name
 *   2. If city name → reverse-geocode via Open-Meteo geocoding API
 *   3. Fetch current + daily forecast via Open-Meteo /v1/forecast
 *   4. Map weather code → human-readable condition (it/en) + icon
 *   5. Cache in-memory 1h per (lat,lon) grid-cell ~1km
 *
 * @module executors/weather
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor, NodeExecutionResult } from '@medea/engine-nodes-stdlib';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

interface CacheEntry {
  value: WeatherOutput;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

interface Location {
  name: string;
  lat: number;
  lon: number;
  country: string;
  timezone: string;
}
interface Current {
  tempC: number;
  feelsLikeC: number;
  humidity: number;
  windKmh: number;
  windDir: number;
  condition: string;
  icon: string;
}
interface ForecastDay {
  date: string;
  minC: number;
  maxC: number;
  condition: string;
  precipitationMm: number;
  icon: string;
}
interface WeatherOutput {
  location: Location;
  current: Current;
  forecast: ForecastDay[];
}

const CONDITION_MAP: Record<number, { it: string; en: string; icon: string }> = {
  0: { it: 'sereno', en: 'clear', icon: '☀️' },
  1: { it: 'prevalentemente sereno', en: 'mainly clear', icon: '🌤️' },
  2: { it: 'parzialmente nuvoloso', en: 'partly cloudy', icon: '⛅' },
  3: { it: 'coperto', en: 'overcast', icon: '☁️' },
  45: { it: 'nebbia', en: 'fog', icon: '🌫️' },
  48: { it: 'nebbia con brina', en: 'depositing rime fog', icon: '🌫️' },
  51: { it: 'pioviggine leggera', en: 'light drizzle', icon: '🌦️' },
  53: { it: 'pioviggine moderata', en: 'moderate drizzle', icon: '🌦️' },
  55: { it: 'pioviggine intensa', en: 'dense drizzle', icon: '🌧️' },
  61: { it: 'pioggia leggera', en: 'slight rain', icon: '🌧️' },
  63: { it: 'pioggia moderata', en: 'moderate rain', icon: '🌧️' },
  65: { it: 'pioggia intensa', en: 'heavy rain', icon: '⛈️' },
  71: { it: 'neve leggera', en: 'slight snow', icon: '🌨️' },
  73: { it: 'neve moderata', en: 'moderate snow', icon: '❄️' },
  75: { it: 'neve intensa', en: 'heavy snow', icon: '❄️' },
  80: { it: 'rovesci leggeri', en: 'slight rain showers', icon: '🌦️' },
  81: { it: 'rovesci moderati', en: 'moderate rain showers', icon: '🌧️' },
  82: { it: 'rovesci violenti', en: 'violent rain showers', icon: '⛈️' },
  95: { it: 'temporale', en: 'thunderstorm', icon: '⛈️' },
  96: { it: 'temporale con grandine leggera', en: 'thunderstorm with slight hail', icon: '⛈️' },
  99: { it: 'temporale con grandine intensa', en: 'thunderstorm with heavy hail', icon: '⛈️' },
};

function mapCondition(code: number, lang: 'it' | 'en'): { condition: string; icon: string } {
  const m = CONDITION_MAP[code];
  if (!m) return { condition: lang === 'it' ? 'condizioni sconosciute' : 'unknown', icon: '❓' };
  return { condition: m[lang], icon: m.icon };
}

function parseLocation(
  raw: string,
): { mode: 'coords'; lat: number; lon: number } | { mode: 'city'; name: string } {
  const trimmed = raw.trim();
  const coordsMatch = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (coordsMatch) {
    const lat = parseFloat(coordsMatch[1]!);
    const lon = parseFloat(coordsMatch[2]!);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { mode: 'coords', lat, lon };
    }
  }
  return { mode: 'city', name: trimmed };
}

interface GeoApiHit {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  timezone: string;
}
async function geocodeCity(name: string, signal?: AbortSignal): Promise<Location> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=it&format=json`;
  // safeOutboundFetch: SSRF guard + per-host circuit breaker + telemetry span.
  // Coerenza standard "breaker everywhere" del codebase (consulente top-2026).
  const res = await safeOutboundFetch(url, {
    timeoutMs: 8000,
    spanName: 'http.outbound.openmeteo.geocode',
    ...(signal ? { externalSignal: signal } : {}),
  });
  if (!res.ok) throw new Error(`weather_node: geocoding fallito (HTTP ${String(res.status)})`);
  const data = await readJsonCapped<{ results?: GeoApiHit[] }>(res);
  const hit = data.results?.[0];
  if (!hit)
    throw new Error(
      `weather_node: località "${name}" non trovata. Prova con coordinate "lat,lon".`,
    );
  return {
    name: hit.name,
    lat: hit.latitude,
    lon: hit.longitude,
    country: hit.country,
    timezone: hit.timezone,
  };
}

interface ForecastApiResponse {
  current?: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    weather_code: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weather_code: number[];
    precipitation_sum: number[];
  };
  timezone?: string;
}

function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}
function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}
function kmhToMph(k: number): number {
  return k * 0.621371;
}
function mmToInch(m: number): number {
  return m / 25.4;
}

export const weatherExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const locationRaw = coerceString(cfg.location ?? '').trim();
  if (!locationRaw) throw new Error('weather_node: "location" è obbligatorio (città o "lat,lon")');
  const forecastDaysRaw = Number(cfg.forecastDays ?? 3);
  const forecastDays = Number.isFinite(forecastDaysRaw)
    ? Math.max(0, Math.min(Math.floor(forecastDaysRaw), 7))
    : 3;
  const units: 'metric' | 'imperial' = cfg.units === 'imperial' ? 'imperial' : 'metric';
  const language: 'it' | 'en' = cfg.language === 'en' ? 'en' : 'it';

  const parsed = parseLocation(locationRaw);
  let location: Location;
  if (parsed.mode === 'city') {
    location = await geocodeCity(parsed.name, context.abortSignal);
  } else {
    location = {
      name: `${parsed.lat.toString()},${parsed.lon.toString()}`,
      lat: parsed.lat,
      lon: parsed.lon,
      country: '',
      timezone: 'auto',
    };
  }

  // Cache key — grid 2 decimali (≈1km), incluso days/units/lang per evitare miss-cache
  const cacheKey = `${location.lat.toFixed(2)},${location.lon.toFixed(2)}|${forecastDays.toString()}|${units}|${language}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { output: cached.value, durationMs: Date.now() - start };
  }

  const fcUrl = new URL(FORECAST_URL);
  fcUrl.searchParams.set('latitude', location.lat.toString());
  fcUrl.searchParams.set('longitude', location.lon.toString());
  fcUrl.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code',
  );
  fcUrl.searchParams.set('timezone', 'auto');
  if (forecastDays > 0) {
    fcUrl.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    );
    fcUrl.searchParams.set('forecast_days', forecastDays.toString());
  }
  const fcRes = await safeOutboundFetch(fcUrl.toString(), {
    timeoutMs: 8000,
    spanName: 'http.outbound.openmeteo.forecast',
    ...(context.abortSignal ? { externalSignal: context.abortSignal } : {}),
  });
  if (!fcRes.ok)
    throw new Error(`weather_node: forecast API fallita (HTTP ${String(fcRes.status)})`);
  const data = await readJsonCapped<ForecastApiResponse>(fcRes);
  if (!data.current) throw new Error('weather_node: risposta API senza campo `current`');

  const cur = data.current;
  const conditionCur = mapCondition(cur.weather_code, language);
  const current: Current = {
    tempC: units === 'metric' ? cur.temperature_2m : cToF(cur.temperature_2m),
    feelsLikeC: units === 'metric' ? cur.apparent_temperature : cToF(cur.apparent_temperature),
    humidity: cur.relative_humidity_2m,
    windKmh: units === 'metric' ? cur.wind_speed_10m : kmhToMph(cur.wind_speed_10m),
    windDir: cur.wind_direction_10m,
    condition: conditionCur.condition,
    icon: conditionCur.icon,
  };

  const forecast: ForecastDay[] = [];
  if (forecastDays > 0 && data.daily) {
    const d = data.daily;
    for (let i = 0; i < d.time.length; i += 1) {
      const cond = mapCondition(d.weather_code[i]!, language);
      forecast.push({
        date: d.time[i]!,
        minC: units === 'metric' ? d.temperature_2m_min[i]! : cToF(d.temperature_2m_min[i]!),
        maxC: units === 'metric' ? d.temperature_2m_max[i]! : cToF(d.temperature_2m_max[i]!),
        condition: cond.condition,
        precipitationMm:
          units === 'metric' ? d.precipitation_sum[i]! : mmToInch(d.precipitation_sum[i]!),
        icon: cond.icon,
      });
    }
  }

  if (data.timezone) location.timezone = data.timezone;

  const output: WeatherOutput = { location, current, forecast };

  // Cache eviction LRU semplice
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, { value: output, expiresAt: Date.now() + CACHE_TTL_MS });

  return { output, durationMs: Date.now() - start } satisfies NodeExecutionResult;
};

// Helpers esposti per test
export const __test__ = {
  parseLocation,
  mapCondition,
  fToC,
  cToF,
  kmhToMph,
  mmToInch,
  clearCache: (): void => cache.clear(),
};
