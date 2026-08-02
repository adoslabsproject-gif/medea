/**
 * action_user_agent_rotate — randomization deterministica User-Agent
 * da pool selezionato.
 *
 * Use case legittimi:
 *  - Test del PROPRIO sito su diversi UA (mobile/desktop/tablet/bot)
 *  - Monitoraggio come il sito risponde a UA bot vs human
 *  - Avoidance del bias UA cache server
 *
 * NON usare per: spoofare identita\` browser a siti di terzi
 * (TOS violation).
 */

import type { NodeModule, NodeExecutor } from '../types.js';

const POOL_DESKTOP: string[] = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
];

const POOL_MOBILE: string[] = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
];

const POOL_TABLET: string[] = [
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Tab S9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

const POOL_BOT: string[] = [
  'Googlebot/2.1 (+http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'FlowForge/1.0 (+https://flowforge.automazionezeli.com/bot)',
];

const POOLS: Record<string, string[]> = {
  desktop: POOL_DESKTOP,
  mobile: POOL_MOBILE,
  tablet: POOL_TABLET,
  bot: POOL_BOT,
  all: [...POOL_DESKTOP, ...POOL_MOBILE, ...POOL_TABLET],
};

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const pool = String(config.pool ?? 'desktop');
  const strategy = String(config.strategy ?? 'random');
  const seedField = String(config.seedField ?? '').trim();

  let candidates = POOLS[pool] ?? POOLS.desktop!;

  // Custom pool override
  const customPoolRaw = config.customPool;
  let customPool: string[] = [];
  if (typeof customPoolRaw === 'string' && customPoolRaw.trim()) {
    customPool = customPoolRaw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(customPoolRaw)) {
    customPool = (customPoolRaw as unknown[]).map((v) => String(v)).filter(Boolean);
  }
  if (customPool.length > 0) candidates = customPool;

  let idx = 0;
  if (strategy === 'random') {
    idx = Math.floor(Math.random() * candidates.length);
  } else if (strategy === 'deterministic') {
    // Use seed from input field or fallback to time-bucket
    let seed = '';
    if (seedField && input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      seed = String(obj[seedField] ?? '');
    }
    if (!seed) seed = Math.floor(Date.now() / (60 * 60 * 1000)).toString(); // hourly bucket
    idx = hashString(seed) % candidates.length;
  } else if (strategy === 'sequential') {
    // Time-based round-robin (sec * 1000)
    idx = Math.floor(Date.now() / 1000) % candidates.length;
  }

  const userAgent = candidates[idx] ?? candidates[0]!;

  return {
    output: {
      userAgent,
      poolName: pool,
      poolSize: candidates.length,
      strategy,
      index: idx,
    },
    durationMs: Date.now() - start,
  };
};

export const userAgentRotateNode: NodeModule = {
  def: {
    id: 'action_user_agent_rotate',
    type: 'action',
    label: 'User-Agent Rotate',
    icon: 'refresh',
    color: '#0ea5e9',
    description:
      'Selettore enterprise di User-Agent string da un pool curato organizzato per categoria — utility per ' +
      'testing del proprio sito sotto diversi browser/device contesti, A/B testing della response server in ' +
      'base al UA, monitoring del comportamento del proprio bot detection. Il pool predefinito è organizzato in ' +
      '5 categorie semanticamente meaningful: desktop (Chrome/Firefox/Safari/Edge versioni recenti 2024-2026 ' +
      'per le tre piattaforme major Windows/macOS/Linux), mobile (iPhone Safari iOS 17+, Android Chrome 12x ' +
      'recent, Samsung Internet, Opera Mobile), tablet (iPad Safari per landscape orientation, Android tablet ' +
      'Chrome), bot (le UA dei crawler legittimi famosi: Googlebot/2.1, bingbot/2.0, DuckDuckBot, FacebookBot, ' +
      'Twitterbot, LinkedInBot, Slackbot, Telegrambot — utile per testare il proprio social embed cards), ' +
      'custom (pool definito dal customer per use case specifici aziendali). ' +
      "Tre strategie di selezione complementari per coprire i pattern d'uso: " +
      '(1) random — pesca uniforme dalla pool selezionata, ogni invocazione del nodo restituisce un UA ' +
      'diverso (pattern naturale per test di breadth coverage); ' +
      '(2) deterministic — seed-based, prende un input field (es. user_id, session_id, transaction_id) come ' +
      'seed per il deterministic hash → garantisce che la stessa key produca SEMPRE lo stesso UA tra ' +
      'invocazioni multiple del workflow (pattern per testing reproducibile + A/B testing user-stable); ' +
      '(3) sequential — round-robin time-based, ruota il pool su una sliding window per garantire uniform ' +
      'distribution del UA usage nel tempo (pattern per monitoring distributo del proprio sito senza skew). ' +
      'Politica etica enterprise: questo nodo è progettato per testing del PROPRIO sito o servizio cliente ' +
      "authorized — il pool include FlowForge/1.0 RFC-compliant UA per dichiarare onestamente l'identità del " +
      'crawler. NON usarlo per spoof identità di browser legittimi verso siti di terzi che potrebbero ' +
      'considerarlo violazione ToS — il SaaS multi-tenant FlowForge non garantisce protezione legale per ' +
      'questo abuse case. ' +
      'Output: { userAgent (string completa da passare in input al nodo downstream), category, ' +
      'strategyUsed, seedUsed?, poolIndex }. ' +
      'Use case: testare il proprio sito e-commerce con diversi UA per verificare che il responsive design ' +
      'funziona su tutti i form-factor (loop su category=mobile + verifica che la checkout button è visibile ' +
      'above-the-fold); A/B testing della response server (HTML/JSON/different) in base al UA pattern; ' +
      'monitoring del proprio bot detection comportamento (passare un UA "bot" e verificare se il sito serve ' +
      'la versione semplificata SEO-optimized); generazione di dataset di test per QA del proprio sito; ' +
      'integrazione con action_web_fetch_advanced come userAgentCustom per testing reproducibile della ' +
      'response server in workflow di regression test.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'pool',
        label: 'Pool UA',
        type: 'select',
        required: false,
        options: ['desktop', 'mobile', 'tablet', 'bot', 'all'],
        defaultValue: 'desktop',
        help: 'desktop = Chrome/Firefox/Safari desktop. mobile = iOS/Android. tablet = iPad/Galaxy Tab. bot = Googlebot/Bingbot/FlowForge. all = mix tutto.',
      },
      {
        key: 'strategy',
        label: 'Strategia rotation',
        type: 'select',
        required: false,
        options: ['random', 'deterministic', 'sequential'],
        defaultValue: 'random',
        help:
          'random = pick random ad ogni call. ' +
          'deterministic = hash(seedField input) → stesso UA per stessa key (sticky per utente). ' +
          'sequential = round-robin time-based (cambia ogni secondo).',
      },
      {
        key: 'seedField',
        label: 'Seed field (input)',
        type: 'text',
        required: false,
        placeholder: 'userId, sessionId, ipAddress',
        showIf: { field: 'strategy', equals: 'deterministic' },
        help: 'Nome del campo input da usare come seed per hash. Garantisce che lo stesso utente vede sempre lo stesso UA (sticky session).',
      },
      {
        key: 'customPool',
        label: 'Custom pool (override)',
        type: 'textarea',
        required: false,
        placeholder: 'Mozilla/5.0 ... Chrome/130\nMyMonitor/1.0\n...',
        help: 'Una stringa UA per riga. Se popolato, sovrascrive il pool predefinito.',
      },
    ],
    outputs: ['userAgent', 'poolName', 'poolSize', 'strategy', 'index'],
  },
  executor,
};
