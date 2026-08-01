/**
 * Tests per honeypot-paths.ts — classificazione pattern scanner.
 *
 * Standard di qualità: copre TUTTE le 15 categorie + TUTTI i pattern regex,
 * verifica zero falsi positivi su path legittimi, idempotency, immutability.
 */

import { describe, it, expect } from 'vitest';
import {
  HONEYPOT_PATTERNS,
  classifyHoneypotPath,
  type HoneypotCategory,
} from '../honeypot-paths.js';

describe('HONEYPOT_PATTERNS', () => {
  it('è frozen (immutabile) — design invariant', () => {
    expect(Object.isFrozen(HONEYPOT_PATTERNS)).toBe(true);
  });

  it('ogni pattern ha category + RegExp + description', () => {
    for (const p of HONEYPOT_PATTERNS) {
      expect(typeof p.category).toBe('string');
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('copre tutte le 11 categorie dichiarate', () => {
    const found = new Set(HONEYPOT_PATTERNS.map((p) => p.category));
    // Expansion 2026-06-02: 25 categorie (11 originali + 14 nuove)
    const expected: HoneypotCategory[] = [
      // Originali (v1)
      'env_leak', 'wordpress_scan', 'shell_probe', 'vcs_leak',
      'admin_panel_probe', 'devops_tool_probe', 'auth_bypass_try',
      'llm_proxy_abuse', 'path_traversal', 'cve_probe', 'info_disclosure',
      // Nuove (v2 — espansione 2026-06-02)
      'cloud_metadata', 'ssrf_probe', 'command_injection',
      'sql_injection', 'nosql_injection', 'cms_scan',
      'webshell_upload', 'java_servlet_probe', 'iot_default_panel',
      'cicd_leak', 'k8s_secret_probe', 'next_internal_probe',
      'aspnet_legacy', 'cryptominer_inject', 'router_cve',
    ];
    for (const cat of expected) {
      expect(found.has(cat)).toBe(true);
    }
    expect(found.size).toBe(expected.length);
  });

  it('tutte le regex usano flag case-insensitive (anti-evasion)', () => {
    for (const p of HONEYPOT_PATTERNS) {
      expect(p.pattern.flags).toContain('i');
    }
  });
});

describe('classifyHoneypotPath — VITE_DEV_PROBE detection (#194 audit)', () => {
  it.each([
    '/@fs/Users/zelistore/zeliAI/package.json',
    '/@id/__x00__virtual:env',
    '/@vite/client',
    '/@vite/env',
    '/@react-refresh',
  ])('classifica %s come info_disclosure (Vite probe)', (path) => {
    const m = classifyHoneypotPath(path);
    expect(m?.category).toBe('info_disclosure');
    expect(m?.description).toMatch(/Vite/i);
  });

  it('/@fs/etc/passwd matcha path_traversal PRIMA (entrambi = ban)', () => {
    // I pattern path_traversal contengono `/etc/passwd` letterale, e il
    // classify ritorna il primo match. Per il use-case (auto-ban dopo
    // 3 hit) entrambe le categorie sono equivalenti — l'IP viene bannato.
    const m = classifyHoneypotPath('/@fs/etc/passwd');
    expect(['path_traversal', 'info_disclosure']).toContain(m?.category);
  });

  it('NON classifica path legittimi che contengono @ (scoped npm)', () => {
    expect(classifyHoneypotPath('/api/v1/templates/@flowforge/core')).toBeNull();
    expect(classifyHoneypotPath('/@anthropic-ai/sdk')).toBeNull();
  });
});

describe('classifyHoneypotPath — ENV_LEAK detection', () => {
  it.each([
    '/.env',
    '/.envrc',
    '/wp/.env',
    '/laravel/.env',
    '/vendor/.env',
    '/admin/.env',
    '/env.backup',
    '/.env.local',
    '/.env.production',
  ])('classifica %s come env_leak', (path) => {
    const m = classifyHoneypotPath(path);
    expect(m?.category).toBe('env_leak');
  });
});

describe('classifyHoneypotPath — WORDPRESS_SCAN detection', () => {
  it.each([
    '/wp-admin/install.php',
    '/wp-admin/',
    '/wp-login.php',
    '/wp-content/themes/x.php',
    '/wp-includes/',
    '/wp-config/',
    '/wp-json/wp/v2/users',
    '/xmlrpc.php',
    '/wlwmanifest.xml',
  ])('classifica %s come wordpress_scan o shell_probe', (path) => {
    const m = classifyHoneypotPath(path);
    expect(['wordpress_scan', 'shell_probe']).toContain(m?.category);
  });
});

describe('classifyHoneypotPath — SHELL_PROBE detection (estensioni script)', () => {
  it.each(['/foo.php', '/bar.asp', '/baz.aspx', '/x.jsp', '/y.cgi', '/z.pl'])(
    'classifica %s come shell_probe',
    (path) => {
      expect(classifyHoneypotPath(path)?.category).toBe('shell_probe');
    },
  );

  it('matcha anche con query string (?)', () => {
    expect(classifyHoneypotPath('/install.php?step=1')?.category).toBe('shell_probe');
  });
});

describe('classifyHoneypotPath — VCS_LEAK detection', () => {
  it.each([
    '/.git/config',
    '/.git/HEAD',
    '/.svn/entries',
    '/.hg/store/00manifest.i',
    '/.bzr/branch-format',
    '/.gitignore',
    '/.gitconfig',
    '/.htaccess',
    '/.htpasswd',
    '/.DS_Store',
  ])('classifica %s come vcs_leak', (path) => {
    const m = classifyHoneypotPath(path);
    expect(m?.category).toBe('vcs_leak');
  });
});

describe('classifyHoneypotPath — ADMIN_PANEL_PROBE detection', () => {
  it.each(['/phpmyadmin/', '/adminer/', '/pma/', '/dbadmin/', '/webdav/', '/webmail/'])(
    'classifica %s come admin_panel_probe',
    (path) => {
      expect(classifyHoneypotPath(path)?.category).toBe('admin_panel_probe');
    },
  );
});

describe('classifyHoneypotPath — DEVOPS_TOOL_PROBE detection', () => {
  it.each([
    '/actuator/health',
    '/jenkins/',
    '/gitlab/',
    '/grafana/',
    '/prometheus/',
    '/kibana/',
    '/elasticsearch/',
    '/consul/',
    '/vault/',
    '/nomad/',
  ])('classifica %s come devops_tool_probe', (path) => {
    expect(classifyHoneypotPath(path)?.category).toBe('devops_tool_probe');
  });
});

describe('classifyHoneypotPath — LLM_PROXY_ABUSE detection', () => {
  it.each([
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings',
    '/v1/models',
    '/openai/anything',
    '/anthropic/something',
    '/gemini-pro/x',
    '/chatgpt/api/',
  ])('classifica %s come llm_proxy_abuse', (path) => {
    expect(classifyHoneypotPath(path)?.category).toBe('llm_proxy_abuse');
  });
});

describe('classifyHoneypotPath — PATH_TRAVERSAL detection', () => {
  it.each([
    '/../../etc/passwd',
    '/api/%2e%2e/file',
    '/etc/passwd',
    '/proc/self/environ',
    '/var/log/apache',
    '/foo/%252e%252e/bar',
  ])('classifica %s come path_traversal', (path) => {
    expect(classifyHoneypotPath(path)?.category).toBe('path_traversal');
  });
});

describe('classifyHoneypotPath — CVE_PROBE detection', () => {
  it.each([
    '/struts2-rest/login',
    '/log4j-test/',
    '/spring-cloud/x',
    '/cve-2021-44228',
    '/exploit.html',
    '/backdoor/',
    '/c99.php',
    '/r57.php',
    '/shell.php',
  ])('classifica %s come cve_probe / shell_probe / webshell_upload', (path) => {
    // Espansione 2026-06-02: c99/r57/shell.php sono webshell noti → match
    // 'webshell_upload' (più specifico di shell_probe generico). Per CVE
    // path generici (log4j, struts2-rest) resta cve_probe.
    const m = classifyHoneypotPath(path);
    expect(['cve_probe', 'shell_probe', 'webshell_upload']).toContain(m?.category);
  });
});

describe('classifyHoneypotPath — INFO_DISCLOSURE detection', () => {
  it.each([
    '/server-status',
    '/server-info',
    '/phpinfo.php',
    '/info.php',
    '/status.php',
  ])('classifica %s come info_disclosure o shell_probe', (path) => {
    const m = classifyHoneypotPath(path);
    expect(['info_disclosure', 'shell_probe']).toContain(m?.category);
  });
});

describe('classifyHoneypotPath — ZERO FALSI POSITIVI su path legittimi', () => {
  it.each([
    '/',
    '/login',
    '/signup',
    '/dashboard',
    '/admin',
    '/admin/users',
    '/admin/workspaces',
    '/api/v1/auth/login',
    '/api/v1/workspaces',
    '/api/v1/admin/users',
    '/integrazioni',
    '/integrazioni/trigger_webhook',
    '/integrazioni/italia_pec_aruba_send',
    '/pricing',
    '/docs',
    '/terms',
    '/privacy',
    '/cookie-policy',
    '/sso/launch',
    '/onboard/workspace',
    '/account/profile',
    '/assets/main.css',
    '/assets/main.js',
    '/fonts/Inter.woff2',
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-pages.xml',
    '/llms.txt',
    '/api/analytics/pageview',
    '/health',
    '/api/v1/gdpr/consent',
    '/products/elettrovalvola-rotork-mm-rb205dbz-2250-24vdc',
  ])('NON classifica %s come honeypot (path legittimo)', (path) => {
    expect(classifyHoneypotPath(path)).toBeNull();
  });
});

describe('classifyHoneypotPath — input invalidi', () => {
  it('stringa vuota → null', () => {
    expect(classifyHoneypotPath('')).toBeNull();
  });

  it('input null/undefined (TS unsafe input) → null', () => {
    expect(classifyHoneypotPath(null as unknown as string)).toBeNull();
    expect(classifyHoneypotPath(undefined as unknown as string)).toBeNull();
  });
});

describe('classifyHoneypotPath — case insensitive (anti-evasion)', () => {
  it.each([
    ['/.ENV', 'env_leak'],
    ['/WP-ADMIN/install.php', 'wordpress_scan'],
    ['/PHPmyAdmin/', 'admin_panel_probe'],
    ['/V1/CHAT/Completions', 'llm_proxy_abuse'],
  ])('rileva attacco maiuscolo %s come %s', (path, expectedCat) => {
    const m = classifyHoneypotPath(path);
    expect(m?.category).toBe(expectedCat);
  });
});

describe('classifyHoneypotPath — return shape', () => {
  it('quando match: ritorna { category, description }', () => {
    const m = classifyHoneypotPath('/.env');
    expect(m).not.toBeNull();
    expect(m).toHaveProperty('category');
    expect(m).toHaveProperty('description');
    expect(typeof m?.description).toBe('string');
    expect(m?.description.length).toBeGreaterThan(0);
  });

  it('quando no match: ritorna null (NON undefined, NON {})', () => {
    expect(classifyHoneypotPath('/login')).toBe(null);
  });
});

describe('classifyHoneypotPath — idempotency', () => {
  it('stessa input → stesso output (deterministico)', () => {
    const path = '/.env';
    expect(classifyHoneypotPath(path)).toEqual(classifyHoneypotPath(path));
  });

  it('non lancia eccezioni su input strani', () => {
    expect(() => classifyHoneypotPath('a'.repeat(10000))).not.toThrow();
    expect(() => classifyHoneypotPath(' ')).not.toThrow();
    expect(() => classifyHoneypotPath('/path with spaces and 日本語')).not.toThrow();
  });
});

// ─── EXPANSION 2026-06-02 — coverage 14 nuove categorie + regression no-false-positive ──
describe('HONEYPOT_PATTERNS v2 — cloud_metadata', () => {
  it('AWS IMDS classico', () => {
    expect(classifyHoneypotPath('/latest/meta-data/iam/security-credentials/')?.category).toBe('cloud_metadata');
  });
  it('GCP computeMetadata', () => {
    expect(classifyHoneypotPath('/computeMetadata/v1/instance/service-accounts/default/token')?.category).toBe('cloud_metadata');
  });
  it('IPv4 IMDS literal 169.254.169.254', () => {
    expect(classifyHoneypotPath('/169.254.169.254/latest/user-data')?.category).toBe('cloud_metadata');
  });
  it('Azure / Oracle / Alibaba metadata', () => {
    expect(classifyHoneypotPath('/opc/v1/instance/')?.category).toBe('cloud_metadata');
    expect(classifyHoneypotPath('/metadata.google.internal/')?.category).toBe('cloud_metadata');
    expect(classifyHoneypotPath('/100.100.100.200/latest/meta-data')?.category).toBe('cloud_metadata');
  });
});

describe('HONEYPOT_PATTERNS v2 — ssrf_probe', () => {
  it('?url=http SSRF', () => {
    expect(classifyHoneypotPath('/proxy?url=http://evil.com/secrets')?.category).toBe('ssrf_probe');
  });
  it('?redirect=gopher:// scheme', () => {
    expect(classifyHoneypotPath('/api/redirect?redirect=gopher://internal:6379/_INFO')?.category).toBe('ssrf_probe');
  });
  it('open proxy endpoint /fetch.php?url=', () => {
    expect(classifyHoneypotPath('/fetch.php?url=http://localhost:8080')?.category).toBe('ssrf_probe');
  });
});

describe('HONEYPOT_PATTERNS v2 — command_injection', () => {
  it('?cmd=ls injection', () => {
    expect(classifyHoneypotPath('/api/exec?cmd=ls')?.category).toBe('command_injection');
  });
  it('shell metacharacter ;cat', () => {
    expect(classifyHoneypotPath('/page?param=;cat')?.category).toBe('command_injection');
  });
  it('backtick injection `whoami`', () => {
    expect(classifyHoneypotPath('/?q=`whoami`')?.category).toBe('command_injection');
  });
});

describe('HONEYPOT_PATTERNS v2 — sql_injection', () => {
  it("UNION SELECT signature", () => {
    expect(classifyHoneypotPath("/api/users?id=1' UNION SELECT password FROM users--")?.category).toBe('sql_injection');
  });
  it("' OR encoded SLEEP", () => {
    expect(classifyHoneypotPath("/login?id=1%27 OR SLEEP(5)--")?.category).toBe('sql_injection');
  });
});

describe('HONEYPOT_PATTERNS v2 — nosql_injection', () => {
  it('MongoDB $gt operator', () => {
    expect(classifyHoneypotPath('/api?username[$gt]=')?.category).toBe('nosql_injection');
  });
  it('$where injection', () => {
    expect(classifyHoneypotPath('/find?filter[$where]=1')?.category).toBe('nosql_injection');
  });
});

describe('HONEYPOT_PATTERNS v2 — cms_scan', () => {
  it('Drupal CHANGELOG.txt fingerprint', () => {
    expect(classifyHoneypotPath('/CHANGELOG.txt')?.category).toBe('cms_scan');
  });
  it('Joomla administrator/index.php', () => {
    expect(classifyHoneypotPath('/administrator/index.php')?.category).toBe('cms_scan');
  });
  it('Magento /magento/', () => {
    expect(classifyHoneypotPath('/magento/index.php')?.category).toBe('cms_scan');
  });
});

describe('HONEYPOT_PATTERNS v2 — webshell_upload', () => {
  it('c99.php classic webshell', () => {
    expect(classifyHoneypotPath('/c99.php')?.category).toBe('webshell_upload');
  });
  it('upload.php endpoint', () => {
    expect(classifyHoneypotPath('/upload.php?file=shell.jsp')?.category).toBe('webshell_upload');
  });
});

describe('HONEYPOT_PATTERNS v2 — java_servlet_probe', () => {
  it('Tomcat /manager/html', () => {
    expect(classifyHoneypotPath('/manager/html/list')?.category).toBe('java_servlet_probe');
  });
  it('Struts2 .action', () => {
    expect(classifyHoneypotPath('/struts/test.action')?.category).toBe('java_servlet_probe');
  });
});

describe('HONEYPOT_PATTERNS v2 — iot_default_panel', () => {
  it('D-Link HNAP1', () => {
    expect(classifyHoneypotPath('/HNAP1/')?.category).toBe('iot_default_panel');
  });
  it('IP camera ONVIF', () => {
    expect(classifyHoneypotPath('/onvif/device_service')?.category).toBe('iot_default_panel');
  });
});

describe('HONEYPOT_PATTERNS v2 — cicd_leak', () => {
  it('.gitlab-ci.yml exposure', () => {
    expect(classifyHoneypotPath('/.gitlab-ci.yml')?.category).toBe('cicd_leak');
  });
  it('Dockerfile probe', () => {
    expect(classifyHoneypotPath('/Dockerfile')?.category).toBe('cicd_leak');
  });
  it('Jenkinsfile probe', () => {
    expect(classifyHoneypotPath('/Jenkinsfile')?.category).toBe('cicd_leak');
  });
});

describe('HONEYPOT_PATTERNS v2 — k8s_secret_probe', () => {
  it('k8s API secrets', () => {
    expect(classifyHoneypotPath('/api/v1/secrets/')?.category).toBe('k8s_secret_probe');
  });
  it('/run/secrets probe', () => {
    expect(classifyHoneypotPath('/run/secrets/db-password')?.category).toBe('k8s_secret_probe');
  });
});

describe('HONEYPOT_PATTERNS v2 — next_internal_probe', () => {
  it('Next.js webpack HMR', () => {
    expect(classifyHoneypotPath('/_next/webpack-hmr')?.category).toBe('next_internal_probe');
  });
  it('__nextjs debug', () => {
    expect(classifyHoneypotPath('/__nextjs_debug')?.category).toBe('next_internal_probe');
  });
});

describe('HONEYPOT_PATTERNS v2 — aspnet_legacy', () => {
  it('trace.axd', () => {
    expect(classifyHoneypotPath('/trace.axd')?.category).toBe('aspnet_legacy');
  });
  it('elmah.axd', () => {
    expect(classifyHoneypotPath('/elmah.axd')?.category).toBe('aspnet_legacy');
  });
  it('web.config.bak', () => {
    expect(classifyHoneypotPath('/web.config.bak')?.category).toBe('aspnet_legacy');
  });
});

describe('HONEYPOT_PATTERNS v2 — cryptominer_inject', () => {
  it('coinhive.min.js beacon', () => {
    expect(classifyHoneypotPath('/coinhive.min.js')?.category).toBe('cryptominer_inject');
  });
});

describe('HONEYPOT_PATTERNS v2 — router_cve', () => {
  it('Mikrotik winbox', () => {
    expect(classifyHoneypotPath('/winbox/index.cgi')?.category).toBe('router_cve');
  });
  it('Fortinet fgt_lang', () => {
    expect(classifyHoneypotPath('/fgt_lang/test')?.category).toBe('router_cve');
  });
});

describe('HONEYPOT_PATTERNS v2 — extended env_leak', () => {
  it('AWS credentials file', () => {
    expect(classifyHoneypotPath('/.aws/credentials')?.category).toBe('env_leak');
  });
  it('SSH id_rsa', () => {
    expect(classifyHoneypotPath('/id_rsa')?.category).toBe('env_leak');
  });
  it('appsettings.json', () => {
    expect(classifyHoneypotPath('/appsettings.json')?.category).toBe('env_leak');
  });
});

describe('HONEYPOT_PATTERNS — CRITICAL: zero false positive su path legit FlowForge', () => {
  const legitPaths = [
    '/login', '/signup', '/logout', '/verify-email', '/forgot-password',
    '/reset-password', '/onboard/2fa',
    '/api/v1/auth/login', '/api/v1/auth/signup', '/api/v1/auth/2fa/onboard/setup',
    '/api/v1/workspaces', '/api/v1/workspaces/abc-123/change-plan',
    '/api/v1/account/billing', '/api/v1/account/billing/invoices',
    '/api/v1/account/billing/invoices/uuid/download',
    '/api/v1/account/billing/invoices/credit-notes/uuid/download',
    '/api/v1/admin/users', '/api/v1/admin/payments',
    '/api/v1/admin/payments/uuid/refund',
    '/api/v1/admin/workspaces/uuid/change-plan',
    '/api/v1/gdpr/erasure-request', '/api/v1/billing/cancel',
    '/api/v1/internal/sentinel/threat',
    '/api/v1/internal/workspaces/list',
    '/api/v1/webhooks/paypal',
    '/api/v1/license-keys/uuid/rotate',
    '/api/v1/llm/chat',
    '/api/v1/byok/openai/key',
    '/api/v1/email-tracking/uuid',
    '/api/v1/i18n/it', '/api/v1/openapi.json', '/api/v1/docs',
    '/account/billing', '/account/billing-details', '/account/team',
    '/account/security', '/account/api-keys', '/account/profile',
    '/admin/users', '/admin/users/uuid', '/admin/workspaces',
    '/admin/workspaces/uuid/custom-domains',
    '/admin/payments', '/admin/email-templates', '/admin/docker-prune',
    '/admin/observability', '/admin/cron', '/admin/database',
    '/assets/main.css', '/assets/main.css?v=123', '/assets/account.js',
    '/assets/logozeli.png', '/favicon.ico', '/favicon-32x32.png',
    '/manifest.json', '/robots.txt', '/sitemap.xml', '/llms.txt',
    '/integrazioni',
    '/integrazioni/ai_openai',
    '/integrazioni/action_xlsx_parse', '/integrazioni/db_sql_query',
    '/integrazioni/italia_sdi_send_invoice',
    '/sicurezza', '/pricing', '/docs',
    '/sso', '/auth/bootstrap', '/auth/status', '/auth/me',
    '/dashboard', '/workflows', '/workflows/uuid/edit',
    '/.well-known/security.txt', '/.well-known/change-password',
    '/about', '/privacy', '/terms', '/cookie', '/cookie-policy',
  ];

  for (const path of legitPaths) {
    it(`legit "${path}" → NO match`, () => {
      const match = classifyHoneypotPath(path);
      if (match) {
        throw new Error(`False positive: "${path}" → ${match.category} (${match.description})`);
      }
      expect(match).toBeNull();
    });
  }
});

describe('HONEYPOT_PATTERNS — match scanner REALI dai log nginx 2026-06-02', () => {
  // Path estratti da /var/log/nginx/access.log oggi
  const realProbes: [string, string][] = [
    ['/.env', 'env_leak'],
    ['/api/.env', 'env_leak'],
    ['/backend/.env', 'env_leak'],
    ['/core/.env', 'env_leak'],
    ['/app/.env', 'env_leak'],
    ['/wp-admin/install.php', 'wordpress_scan'],
    ['/wp-includes/js/jquery/jquery.js', 'wordpress_scan'],
    ['/actuator/env', 'devops_tool_probe'],
    ['/actuator/configprops', 'devops_tool_probe'],
    ['/.git/HEAD', 'vcs_leak'],
    ['/.git/config', 'vcs_leak'],
    ['/.htpasswd', 'vcs_leak'],
    ['/onvif/device_service', 'iot_default_panel'],
    ['/phpinfo.php', 'shell_probe'],
  ];
  for (const [path, expectedCat] of realProbes) {
    it(`scanner reale "${path}" → ${expectedCat}`, () => {
      const m = classifyHoneypotPath(path);
      expect(m, `Expected match per ${path}`).not.toBeNull();
      expect(m?.category).toBe(expectedCat);
    });
  }
});

describe('HONEYPOT_PATTERNS — coverage totale (regression guard)', () => {
  it('Almeno 40 pattern (v1=18, v2=22 aggiunti)', () => {
    expect(HONEYPOT_PATTERNS.length).toBeGreaterThanOrEqual(40);
  });
  it('Almeno 25 categorie coperte', () => {
    const cats = new Set(HONEYPOT_PATTERNS.map((p) => p.category));
    expect(cats.size).toBeGreaterThanOrEqual(25);
  });
});
