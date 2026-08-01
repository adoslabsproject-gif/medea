/**
 * `weather_node` — meteo current + forecast via Open-Meteo.
 *
 * Perché Open-Meteo
 * ─────────────────
 * Free, no API key, no rate-limit per uso ragionevole, CC-BY 4.0 attribution.
 * Data source autorevole (sintesi multi-model: ECMWF, ICON, GFS, MeteoFrance).
 * Endpoint reverse-geocoding incluso → l'utente passa il nome città e il
 * nodo risolve coords automatico.
 *
 * Cache in-memory 1h per (lat,lon) round-down 2 decimali → ~1km grid.
 * Pattern standard meteo: i dati cambiano ogni ora, non serve real-time.
 *
 * Output
 * ──────
 *   {
 *     location: { name, lat, lon, country, timezone },
 *     current: { tempC, feelsLikeC, humidity, windKmh, windDir, condition, icon },
 *     forecast: [{ date, minC, maxC, condition, precipitationMm }, ...] // 7gg
 *   }
 *
 * @module actions/weather
 */

import type { NodeModule } from '../types.js';

export const weatherNode: NodeModule = {
  def: {
    id: 'weather_node',
    type: 'action',
    label: 'Meteo: condizioni + forecast 7gg',
    icon: 'cloud-sun',
    color: '#0ea5e9',
    description:
      'Nodo meteo enterprise che recupera condizioni atmosferiche correnti e forecast 7 giorni per qualsiasi ' +
      'località del mondo, usando l\'API pubblica Open-Meteo (servizio europeo gratuito senza API key, basato ' +
      'su modelli ECMWF + DWD + GFS + ICON e altri 8 modelli meteorologici nazionali, dati licenziati CC-BY ' +
      '4.0 per uso commerciale libero) — alternativa a OpenWeatherMap (richiede API key con quota), WeatherAPI ' +
      '(paid tier oltre il free 1M req/month), AccuWeather (API molto costoso) o Tomorrow.io. Il sourcing ' +
      'europeo è particolarmente accurato per Italia + Europa con risoluzione 1-3 km grid + update 6× al giorno. ' +
      'Reverse-geocoding incluso nativo: l\'utente passa il nome città in linguaggio naturale italiano (es. ' +
      '"Roma", "Milano", "Bari Vecchia", "Termoli", "San Giovanni Rotondo") e il nodo risolve automatic le ' +
      'coordinate lat/lon via Open-Meteo geocoding API che ha copertura di città + paesi + frazioni con ' +
      'matching fuzzy + disambiguation su omonimi (es. "Cesena" vs "Cesenatico"); supporta anche lat/lon ' +
      'diretti per power user che già hanno le coordinate da GPS o altri sistemi. ' +
      'Cache in-memory smart: TTL 1h per chiave (lat, lon rounded a 0.1° per merge di richieste vicine) — ' +
      'workflow batch che colpiscono la stessa città N volte (es. cron orario di 50 negozi di Roma) NON ' +
      'spammano l\'API Open-Meteo che è generously rate-limited ma comunque non infinita. ' +
      'Output structured consumabile direttamente da dashboard SSR/email digest/IoT automation: { current: ' +
      '{ temperature, humidity, wind_speed, wind_direction, weather_code, is_day, time }, forecast: [{ date, ' +
      'temp_max, temp_min, precipitation_sum, precipitation_probability, weather_code, uv_index_max }], ' +
      'location: { name, country, lat, lon, timezone }, meta: { units, model_source, generated_at } }. ' +
      'Weather code mapping a italiano per UI-friendly display: 0=sereno, 1=poco nuvoloso, 2=parzialmente ' +
      'nuvoloso, 3=coperto, 45=nebbia, 48=nebbia gelata, 51=pioggerellina leggera, 53=pioggerellina, ' +
      '55=pioggerellina intensa, 61=pioggia leggera, 63=pioggia, 65=pioggia intensa, ecc. (codici WMO 4677). ' +
      'Use case: digest meteo giornaliero per agenzia turistica italiana inviato via email ai propri clienti ' +
      'con previsioni delle località del pacchetto vacanza; alert temperatura per monitoraggio magazzino ' +
      'refrigerato (cron 30min + check temp < 2°C → notify ops se prevista grandinata che potrebbe danneggiare ' +
      'sistemi); automazione IoT spegni-AC se outdoor temperature < 20°C (workflow che integra weather + ' +
      'sensor temperature interno + relay control via webhook smart-home Aqara/Shelly); widget meteo embedded ' +
      'in dashboard tenant agency travel che mostra il meteo per destinazioni preferite del customer; ' +
      'optimization logistica trasporti pesanti (autotreno) che evita le rotte con maltempo previsto +24h.',
    configFields: [
      {
        key: 'location',
        label: 'Località',
        type: 'expression',
        required: true,
        placeholder: 'Roma   oppure   45.4642,9.1900',
        help: 'Nome città (es. "Milano", "Roma, IT") oppure coordinate "lat,lon" (es. "45.4642,9.1900"). ' +
          'Il reverse-geocoding usa Open-Meteo geocoding API.',
      },
      {
        key: 'forecastDays',
        label: 'Giorni forecast (0–7)',
        type: 'number',
        required: false,
        defaultValue: '3',
        help: 'Default 3 giorni. Max 7. Imposta 0 per ricevere solo le condizioni correnti (no forecast).',
      },
      {
        key: 'units',
        label: 'Unità misura',
        type: 'select',
        required: false,
        defaultValue: 'metric',
        options: ['metric', 'imperial'],
        help: 'Default metric (°C, km/h, mm). Imperial converte °C→°F, km/h→mph, mm→inch.',
      },
      {
        key: 'language',
        label: 'Lingua condizioni',
        type: 'select',
        required: false,
        defaultValue: 'it',
        options: ['it', 'en'],
        help: 'Lingua per il campo `condition`: "it" → "sereno/temporale", "en" → "clear/thunderstorm".',
      },
    ],
    outputs: ['location', 'current', 'forecast'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 250 },
  },
};
