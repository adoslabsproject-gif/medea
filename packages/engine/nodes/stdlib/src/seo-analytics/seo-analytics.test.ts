/**
 * SEO + Analytics nodes — test 2026-grade.
 *
 * Coverage REALE (no smoke):
 *   - meta-extract: OG/Twitter/JSON-LD parsing + soft warnings
 *   - seo-audit: scoring 0-100, grade ramp, classification issues, link classify
 *   - keyword-density: stoplist IT/EN, n-gram count, target tracking, density math
 *
 * redirect-chain + link-audit fanno network call → test separato con mock.
 */
import { describe, it, expect } from 'vitest';
import { metaExtractNode } from './meta-extract.js';
import { seoAuditNode } from './seo-audit.js';
import { keywordDensityNode } from './keyword-density.js';

const CTX = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;

describe('action_meta_extract', () => {
  it('parse title, description, canonical', async () => {
    const html = `
      <html lang="it"><head>
        <title>Acme Workflow Automation</title>
        <meta name="description" content="Piattaforma SaaS per workflow AI in EU, on-prem, container per tenant.">
        <link rel="canonical" href="https://acme.com/home">
        <meta name="robots" content="index,follow">
      </head><body></body></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { title: string; description: string; canonical: string; lang: string; robots: string };
    expect(out.title).toBe('Acme Workflow Automation');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    expect(out.description?.startsWith('Piattaforma SaaS')).toBe(true);
    expect(out.canonical).toBe('https://acme.com/home');
    expect(out.lang).toBe('it');
    expect(out.robots).toBe('index,follow');
  });

  it('parse Open Graph + Twitter Card', async () => {
    const html = `<html><head>
      <meta property="og:title" content="Hero">
      <meta property="og:image" content="https://acme.com/og.png">
      <meta property="og:type" content="website">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:site" content="@acme">
    </head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { og: Record<string, string>; twitter: Record<string, string> };
    expect(out.og.title).toBe('Hero');
    expect(out.og.image).toBe('https://acme.com/og.png');
    expect(out.og.type).toBe('website');
    expect(out.twitter.card).toBe('summary_large_image');
    expect(out.twitter.site).toBe('@acme');
  });

  it('parse JSON-LD structured data', async () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Organization","name":"Acme"}
    </script></head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { jsonLd: { '@type': string; name: string }[] };
    expect(out.jsonLd).toHaveLength(1);
    expect(out.jsonLd[0]?.['@type']).toBe('Organization');
    expect(out.jsonLd[0]?.name).toBe('Acme');
  });

  it('JSON-LD malformato non crasha (parse silenzioso)', async () => {
    const html = `<html><head><script type="application/ld+json">
      {invalid json}
    </script></head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { jsonLd: unknown[] };
    expect(out.jsonLd).toEqual([]);
  });

  it('warnings: missing title + missing description + canonical missing', async () => {
    const html = `<html><body><h1>X</h1></body></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { warnings: string[] };
    expect(out.warnings.some((w) => w.includes('Missing <title>'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('Missing meta description'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('Missing <link rel="canonical">'))).toBe(true);
  });

  it('warnings: title troppo lungo / troppo corto', async () => {
    const longTitle = 'a'.repeat(80);
    const html = `<html><head><title>${longTitle}</title></head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { warnings: string[]; title: string };
    expect(out.warnings.some((w) => w.includes('Title too long'))).toBe(true);
  });

  it('hreflang alternates raccolti', async () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="it" href="https://acme.com/it/">
      <link rel="alternate" hreflang="en" href="https://acme.com/en/">
      <link rel="alternate" hreflang="x-default" href="https://acme.com/">
    </head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { hreflang: { lang: string; href: string }[] };
    expect(out.hreflang).toHaveLength(3);
    expect(out.hreflang[0]?.lang).toBe('it');
    expect(out.hreflang[2]?.lang).toBe('x-default');
  });

  it('keywords splitted by comma', async () => {
    const html = `<html><head><meta name="keywords" content="workflow, ai, saas, eu, gdpr"></head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { keywords: string[] };
    expect(out.keywords).toEqual(['workflow', 'ai', 'saas', 'eu', 'gdpr']);
  });
});

describe('action_seo_audit', () => {
  it('pagina ben fatta: score >= 80, grade A o B', async () => {
    const html = `<html lang="it"><head>
      <title>FlowForge Workflow Automation EU on-prem</title>
      <meta name="description" content="FlowForge è la piattaforma SaaS per workflow AI on-premise EU. Container isolato per tenant, GDPR-native, audit immutable.">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="canonical" href="https://flowforge.io/">
      <meta property="og:title" content="FlowForge"><meta property="og:image" content="https://x/og.png">
      <meta name="robots" content="index,follow">
    </head><body>
      <h1>FlowForge</h1>
      <p>${'Contenuto utile e lungo. '.repeat(60)}</p>
      <a href="/internal">Internal</a><a href="https://external.com">External</a>
      <img src="/x.png" alt="X">
    </body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { score: number; grade: string; issues: { severity: string }[] };
    expect(out.score).toBeGreaterThanOrEqual(80);
    expect(['A', 'B']).toContain(out.grade);
    expect(out.issues.filter((i) => i.severity === 'critical')).toHaveLength(0);
  });

  it('pagina senza title/description/canonical/h1: grade F, score basso', async () => {
    const html = `<html><body><p>nothing</p></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { score: number; grade: string; issues: { code: string; severity: string }[] };
    const criticalCodes = out.issues.filter((i) => i.severity === 'critical').map((i) => i.code);
    expect(criticalCodes).toContain('NO_TITLE');
    expect(criticalCodes).toContain('NO_DESCRIPTION');
    expect(criticalCodes).toContain('NO_H1');
    expect(out.score).toBeLessThan(60);
    expect(['D', 'F']).toContain(out.grade);
  });

  it('noindex robots flagged critical', async () => {
    const html = `<html><head><title>OK ok ok ok ok</title><meta name="robots" content="noindex,nofollow"></head><body><h1>X</h1></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { issues: { code: string }[] };
    expect(out.issues.some((i) => i.code === 'NOINDEX')).toBe(true);
  });

  it('multiple H1 warning', async () => {
    const html = `<html><body><h1>A</h1><h1>B</h1></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { h1: { count: number; ok: boolean }; issues: { code: string }[] };
    expect(out.h1.count).toBe(2);
    expect(out.h1.ok).toBe(false);
    expect(out.issues.some((i) => i.code === 'MULTIPLE_H1')).toBe(true);
  });

  it('image missing alt: warning + counter', async () => {
    const html = `<html><body><img src="a.png"><img src="b.png" alt="ok"></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { images: { total: number; missingAlt: number }; issues: { code: string }[] };
    expect(out.images.total).toBe(2);
    expect(out.images.missingAlt).toBe(1);
    expect(out.issues.some((i) => i.code === 'IMG_MISSING_ALT')).toBe(true);
  });

  it('classify internal/external links — base URL da input', async () => {
    const html = `<html><body>
      <a href="/page1">Internal</a>
      <a href="https://flowforge.io/page2">Internal absolute</a>
      <a href="https://external.com">External</a>
      <a href="#anchor">Anchor</a>
      <a href="mailto:a@b.c">Mail</a>
    </body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'input' }, { body: html, url: 'https://flowforge.io/' }, CTX);
    const out = r.output as { links: { internal: number; external: number; total: number } };
    expect(out.links.internal).toBe(2);
    expect(out.links.external).toBe(1);
    expect(out.links.total).toBe(5);
  });

  it('schema.org JSON-LD types collected', async () => {
    const html = `<html><head>
      <title>OK ok ok ok ok</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":["Product","Offer"]}</script>
    </head><body><h1>X</h1></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { schemaTypes: string[] };
    expect(out.schemaTypes.sort()).toEqual(['Offer', 'Organization', 'Product']);
  });

  it('grade ramp: A>=90, B>=75, C>=60, D>=40, F<40', async () => {
    // basta verificare 2 punti del ramp
    const goodHtml = `<html lang="it"><head>
      <title>FlowForge Workflow Automation EU</title>
      <meta name="description" content="${'x'.repeat(120)}">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="canonical" href="https://x/">
      <meta property="og:title" content="X"><meta property="og:image" content="https://x/og">
    </head><body><h1>X</h1><h2>Sub</h2><p>${'word '.repeat(400)}</p></body></html>`;
    const r1 = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: goodHtml }, null, CTX);
    const out1 = r1.output as { score: number; grade: string };
    expect(out1.score).toBe(100);
    expect(out1.grade).toBe('A');
  });
});

describe('action_keyword_density', () => {
  it('tokenize testo italiano accentato corretto', async () => {
    const text = 'Il nostro workflow è perfetto. Workflow automatico per aziende. Workflow personalizzato.';
    const r = await keywordDensityNode.executor!({ textExplicit: text, lang: 'it', minLen: '3' }, null, CTX);
    const out = r.output as { totalTokens: number; unigrams: { term: string; count: number; density: number }[] };
    expect(out.totalTokens).toBeGreaterThan(0);
    const wf = out.unigrams.find((u) => u.term === 'workflow');
    expect(wf?.count).toBe(3);
    expect(wf?.density).toBeGreaterThan(0);
  });

  it('stopwords IT escluse dagli unigrammi', async () => {
    const text = 'il la di a da in con e ma è sono workflow workflow';
    const r = await keywordDensityNode.executor!({ textExplicit: text, lang: 'it', minLen: '1' }, null, CTX);
    const out = r.output as { unigrams: { term: string }[] };
    const terms = out.unigrams.map((u) => u.term);
    expect(terms).not.toContain('il');
    expect(terms).not.toContain('la');
    expect(terms).not.toContain('di');
    expect(terms).toContain('workflow');
  });

  it('stopwords EN escluse', async () => {
    const text = 'the workflow is the workflow';
    const r = await keywordDensityNode.executor!({ textExplicit: text, lang: 'en', minLen: '2' }, null, CTX);
    const out = r.output as { unigrams: { term: string }[] };
    const terms = out.unigrams.map((u) => u.term);
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('is');
    expect(terms).toContain('workflow');
  });

  it('bigrammi calcolati e ordinati per frequenza', async () => {
    const text = 'workflow automation enterprise. workflow automation pro. workflow design.';
    const r = await keywordDensityNode.executor!({ textExplicit: text, lang: 'en', minLen: '3' }, null, CTX);
    const out = r.output as { bigrams: { term: string; count: number }[] };
    const wa = out.bigrams.find((b) => b.term === 'workflow automation');
    expect(wa?.count).toBe(2);
  });

  it('target keywords: count + density per ogni keyword', async () => {
    const text = 'workflow ai workflow ai chatbot workflow';
    const r = await keywordDensityNode.executor!({
      textExplicit: text,
      lang: 'en',
      minLen: '2',
      targetKeywords: 'workflow ai\nchatbot',
    }, null, CTX);
    const out = r.output as { targetKeywords: { term: string; count: number; density: number }[] };
    const wfai = out.targetKeywords.find((t) => t.term === 'workflow ai');
    const cb = out.targetKeywords.find((t) => t.term === 'chatbot');
    expect(wfai?.count).toBe(2);
    expect(cb?.count).toBe(1);
    expect(wfai?.density).toBeGreaterThan(0);
  });

  it('HTML viene pulito da script/style prima di tokenize', async () => {
    const html = `<html><head><style>body{color:red}.x{background:blue}</style></head>
      <body><script>console.log("ignored")</script>workflow workflow</body></html>`;
    const r = await keywordDensityNode.executor!({ textExplicit: html, lang: 'en', minLen: '3' }, null, CTX);
    const out = r.output as { unigrams: { term: string }[] };
    const terms = out.unigrams.map((u) => u.term);
    expect(terms).toContain('workflow');
    expect(terms).not.toContain('color');
    expect(terms).not.toContain('console');
    expect(terms).not.toContain('background');
  });

  it('custom stopwords aggiunte alla blacklist', async () => {
    const text = 'workflow acme acme acme automation';
    const r = await keywordDensityNode.executor!({
      textExplicit: text,
      lang: 'en',
      minLen: '3',
      customStop: 'acme',
    }, null, CTX);
    const out = r.output as { unigrams: { term: string }[] };
    const terms = out.unigrams.map((u) => u.term);
    expect(terms).not.toContain('acme');
    expect(terms).toContain('workflow');
  });

  it('empty input: warnings + totalTokens=0', async () => {
    const r = await keywordDensityNode.executor!({ textExplicit: '' }, null, CTX);
    const out = r.output as { totalTokens: number; warnings: string[] };
    expect(out.totalTokens).toBe(0);
    expect(out.warnings).toContain('Empty input');
  });

  it('density math: total=100 tokens, term ricorre 5 volte → density 5%', async () => {
    const tokens = ['filler']
      .concat(Array(95).fill('different-word'))
      .concat(Array(5).fill('target-word'))
      .join(' ');
    const r = await keywordDensityNode.executor!({
      textExplicit: tokens,
      lang: 'en',
      minLen: '3',
      customStop: 'filler,different-word',
    }, null, CTX);
    const out = r.output as { unigrams: { term: string; density: number; count: number }[]; totalTokens: number };
    const tw = out.unigrams.find((u) => u.term === 'target-word');
    expect(tw?.count).toBe(5);
    expect(out.totalTokens).toBe(101);
    expect(tw?.density).toBeCloseTo(4.95, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ondata 8c — gap costruiti: feature aggiunte ai nodi SEO zero-network
// ─────────────────────────────────────────────────────────────────────────────

describe('🔬 meta_extract — favicon / theme-color / metaExtra / hreflang valid', () => {
  it('favicon (icon/shortcut/apple-touch) + theme-color estratti', async () => {
    const html = `<html><head>
      <link rel="icon" href="/favicon.ico">
      <meta name="theme-color" content="#0ea5e9">
    </head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { favicon: string | null; themeColor: string | null };
    expect(out.favicon).toBe('/favicon.ico');
    expect(out.themeColor).toBe('#0ea5e9');
  });

  it('🚨 meta name non-standard raccolti in metaExtra', async () => {
    const html = `<html><head>
      <meta name="generator" content="FlowForge">
      <meta name="application-name" content="App">
    </head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { metaExtra: Record<string, string> };
    expect(out.metaExtra.generator).toBe('FlowForge');
    expect(out.metaExtra['application-name']).toBe('App');
  });

  it('🚨 hreflang: codice valido vs invalido + warning', async () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="it-IT" href="https://x/it">
      <link rel="alternate" hreflang="not_a_lang" href="https://x/zz">
    </head></html>`;
    const r = await metaExtractNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { hreflang: { lang: string; valid: boolean }[]; warnings: string[] };
    expect(out.hreflang.find((h) => h.lang === 'it-IT')?.valid).toBe(true);
    expect(out.hreflang.find((h) => h.lang === 'not_a_lang')?.valid).toBe(false);
    expect(out.warnings.some((w) => w.includes('Invalid hreflang'))).toBe(true);
  });
});

describe('🔬 seo_audit — viewport / heading-skip / favicon', () => {
  it('🚨 viewport mancante → issue NO_VIEWPORT (info)', async () => {
    const html = `<html lang="it"><head><title>Titolo lungo abbastanza ok</title></head><body><h1>X</h1></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { issues: { code: string; severity: string }[]; viewport: string | null };
    expect(out.viewport).toBeNull();
    expect(out.issues.some((i) => i.code === 'NO_VIEWPORT' && i.severity === 'info')).toBe(true);
  });

  it('🚨 heading skip h1→h3 → issue HEADING_SKIP con evidence', async () => {
    const html = `<html><body><h1>A</h1><h3>salto</h3></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { headingSkips: { from: number; to: number }[]; issues: { code: string; evidence?: string }[] };
    expect(out.headingSkips).toEqual([{ from: 1, to: 3 }]);
    const skip = out.issues.find((i) => i.code === 'HEADING_SKIP');
    expect(skip?.evidence).toBe('h1 → h3');
  });

  it('gerarchia corretta h1→h2→h3 → nessun HEADING_SKIP', async () => {
    const html = `<html><body><h1>A</h1><h2>B</h2><h3>C</h3></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    expect((r.output as { headingSkips: unknown[] }).headingSkips).toHaveLength(0);
  });

  it('favicon + theme-color estratti come campi', async () => {
    const html = `<html><head><title>Titolo ok ok ok</title><link rel="icon" href="/f.png"><meta name="theme-color" content="#fff"></head><body><h1>X</h1></body></html>`;
    const r = await seoAuditNode.executor!({ htmlSource: 'explicit', htmlExplicit: html }, null, CTX);
    const out = r.output as { favicon: string | null; themeColor: string | null };
    expect(out.favicon).toBe('/f.png');
    expect(out.themeColor).toBe('#fff');
  });
});

describe('🔬 keyword_density — accent-folding / nav-footer strip / DE-FR-ES', () => {
  it('🚨 stripAccents ON: "caffè" e "caffe" collassano nello stesso token', async () => {
    const r = await keywordDensityNode.executor!({ textExplicit: 'caffè caffe caffè', lang: 'it', minLen: '3', stripAccents: true }, null, CTX);
    const out = r.output as { unigrams: { term: string; count: number }[] };
    const caffe = out.unigrams.find((u) => u.term === 'caffe');
    expect(caffe?.count).toBe(3);
  });

  it('stripAccents OFF (default): "caffè" e "caffe" restano distinti', async () => {
    const r = await keywordDensityNode.executor!({ textExplicit: 'caffè caffe', lang: 'it', minLen: '3' }, null, CTX);
    const out = r.output as { unigrams: { term: string }[] };
    const terms = out.unigrams.map((u) => u.term);
    expect(terms).toContain('caffè');
    expect(terms).toContain('caffe');
  });

  it('🚨 nav/footer/header rimossi dal conteggio (boilerplate escluso)', async () => {
    const html = `<html><body>
      <nav>menu home contatti chisiamo</nav>
      <main>workflow workflow workflow</main>
      <footer>privacy cookie menu</footer>
    </body></html>`;
    const r = await keywordDensityNode.executor!({ textExplicit: html, lang: 'it', minLen: '3' }, null, CTX);
    const terms = (r.output as { unigrams: { term: string }[] }).unigrams.map((u) => u.term);
    expect(terms).toContain('workflow');
    expect(terms).not.toContain('menu');
    expect(terms).not.toContain('privacy');
  });

  it('stoplist DE esclude articoli/preposizioni tedesche', async () => {
    const r = await keywordDensityNode.executor!({ textExplicit: 'der die das und workflow workflow', lang: 'de', minLen: '3' }, null, CTX);
    const terms = (r.output as { unigrams: { term: string }[] }).unigrams.map((u) => u.term);
    expect(terms).not.toContain('der');
    expect(terms).not.toContain('und');
    expect(terms).toContain('workflow');
  });

  it('stoplist ES + FR escludono i rispettivi function words', async () => {
    const es = await keywordDensityNode.executor!({ textExplicit: 'el la los por workflow workflow', lang: 'es', minLen: '2' }, null, CTX);
    expect((es.output as { unigrams: { term: string }[] }).unigrams.map((u) => u.term)).not.toContain('los');
    const fr = await keywordDensityNode.executor!({ textExplicit: 'le les des avec workflow workflow', lang: 'fr', minLen: '2' }, null, CTX);
    expect((fr.output as { unigrams: { term: string }[] }).unigrams.map((u) => u.term)).not.toContain('avec');
  });
});
