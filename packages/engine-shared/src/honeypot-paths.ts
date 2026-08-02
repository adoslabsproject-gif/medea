/**
 * Honeypot path detection — centralized scanner-attack pattern set.
 *
 * Maintained as the single source of truth for "this path could only be a
 * malicious probe" decisions. Used by Hono middlewares in zeli-chat and
 * portal to trigger Sentinel `/honeypot/hit` (which auto-bans repeat
 * offenders after HONEYPOT_BAN_THRESHOLD hits per IP within 24h).
 *
 * Design constraints:
 *  - ZERO false positives on legitimate app paths (/login, /signup, /api/v1/*,
 *    /admin/*, /assets/*, /_next/*, /sso/*, ecc.)
 *  - Each pattern documents what attack family it catches
 *  - Categories mirror those used by scripts/server-analytics.sh so reports
 *    are consistent across log analytics and runtime detection
 *
 * Pattern is a `RegExp` evaluated against the request path (no query string).
 * Match order does not matter — a single match is enough to classify as
 * honeypot.
 */

export type HoneypotCategory =
  | 'env_leak'
  | 'wordpress_scan'
  | 'shell_probe'
  | 'vcs_leak'
  | 'admin_panel_probe'
  | 'devops_tool_probe'
  | 'auth_bypass_try'
  | 'llm_proxy_abuse'
  | 'path_traversal'
  | 'cve_probe'
  | 'info_disclosure'
  | 'cloud_metadata' // AWS IMDS, GCP metadata, Azure IMDS
  | 'ssrf_probe' // server-side request forgery
  | 'command_injection' // ?cmd=, ?exec=, shell metacharacters in query
  | 'sql_injection' // UNION SELECT, OR 1=1, sleep()
  | 'nosql_injection' // $gt $ne $where $regex
  | 'cms_scan' // Drupal/Joomla/Magento/Shopify fingerprint
  | 'webshell_upload' // c99/r57/jsp shell upload patterns
  | 'java_servlet_probe' // Tomcat /manager, /examples, JSP, Struts
  | 'iot_default_panel' // router/camera/printer default admin paths
  | 'cicd_leak' // Jenkinsfile, .gitlab-ci.yml, workflows exposed
  | 'k8s_secret_probe' // /api/v1/secrets, /run/secrets, etcd
  | 'next_internal_probe' // Next.js _next/*, __nextapi
  | 'aspnet_legacy' // trace.axd, ELMAH, web.config probe
  | 'cryptominer_inject' // coinhive / cryptominer beacon
  | 'router_cve'; // CVE-202x router/IoT panels

export interface HoneypotPattern {
  category: HoneypotCategory;
  pattern: RegExp;
  description: string;
}

export const HONEYPOT_PATTERNS: readonly HoneypotPattern[] = Object.freeze([
  // ────────────────────────────────────────────────────────────────
  // SPECIFIC PATTERNS FIRST — classifyHoneypotPath usa first-match-wins,
  // quindi pattern più specifici (router_cve, iot, k8s, ...) DEVONO essere
  // valutati PRIMA di quelli generici (shell_probe `.cgi/.php` catch-all).
  // Esempio: /winbox/index.cgi → vogliamo router_cve, non shell_probe.
  // ────────────────────────────────────────────────────────────────

  // Router/firewall CVE-specific (Mikrotik, Fortinet, F5)
  {
    category: 'router_cve',
    pattern: /\/(?:winbox\/index\.cgi|fgt_lang|fortimanager|big-?ip|rest\/uri\/login|mgmt\/tm)/i,
    description: 'Router/firewall CVE-rich path (Mikrotik/Fortinet/F5)',
  },

  // IoT / router default panels
  {
    category: 'iot_default_panel',
    pattern:
      /\/(?:setup\.cgi|status\.cgi|HNAP1|hndUnblock\.cgi|cgi-bin\/(?:luci|hedwig\.cgi|tmUnblock\.cgi))/i,
    description: 'Router/IoT default CGI panel (D-Link, Netgear, Linksys, etc)',
  },
  {
    category: 'iot_default_panel',
    pattern: /\/(?:onvif|axis-cgi|view\/viewer_index\.shtml|admin\/cgi-bin\/getalarm)/i,
    description: 'IP camera / DVR default endpoint',
  },

  // Webshell upload (.php noto MA classificato come webshell se nome canonical)
  {
    category: 'webshell_upload',
    pattern:
      /\/(?:c99|r57|wso|b374k|aspydoor|webadmin|FilesMan|p0wny|tinyfilemanager)(?:\.php|\.asp|\.aspx|\.jsp)?$/i,
    description: 'Known webshell filename / upload target',
  },
  {
    category: 'webshell_upload',
    pattern: /\/(?:upload(?:er|s)?|file_upload|fileupload)\.(?:php|asp|aspx|jsp|jspx)(?:\?|$)/i,
    description: 'Generic file upload endpoint probe',
  },

  // K8s secrets / service account (specifico, before path_traversal /etc)
  {
    category: 'k8s_secret_probe',
    pattern:
      /\/(?:api\/v1\/(?:secrets|configmaps|serviceaccounts)|run\/secrets|var\/run\/secrets|service-account-token)/i,
    description: 'Kubernetes secret/service-account exposure probe',
  },

  // Cloud metadata endpoints — IMDS abuse
  {
    category: 'cloud_metadata',
    pattern:
      /\/(?:latest\/(?:meta-data|user-data|dynamic\/instance-identity)|computeMetadata\/v\d+\/|metadata\/instance|169\.254\.169\.254|fd00:ec2::254)/i,
    description: 'AWS/GCP/Azure IMDS metadata endpoint probe',
  },
  {
    category: 'cloud_metadata',
    pattern: /\/(?:opc\/v1\/instance|metadata\.google\.internal|100\.100\.100\.200)/i,
    description: 'Oracle/Google/Alibaba metadata endpoint',
  },

  // Next.js internal routes
  {
    category: 'next_internal_probe',
    pattern:
      /\/(?:_next\/(?:server|webpack-hmr|on-demand-entries)|__nextjs_original-stack-frame|__nextjs_(?:debug|launch-editor))/i,
    description: 'Next.js dev/internal endpoint enumeration',
  },

  // ASP.NET legacy (.config matches BEFORE generic config)
  {
    category: 'aspnet_legacy',
    pattern: /\/(?:trace\.axd|elmah\.axd|web\.config(?:\.bak)?|app_offline\.htm|app_data\/)/i,
    description: 'ASP.NET legacy diagnostic / config file probe',
  },

  // Java servlet / Tomcat / Struts
  {
    category: 'java_servlet_probe',
    pattern:
      /\/(?:manager\/html|host-manager|examples\/servlets|examples\/jsp|axis2-admin)(?:\/|$)/i,
    description: 'Tomcat manager / Axis2 admin probe (CVE-rich)',
  },
  {
    category: 'java_servlet_probe',
    pattern: /\/(?:struts|action|do)\/.*(?:\.action|\.do|\.action!)/i,
    description: 'Struts2 action OGNL injection target',
  },

  // CI/CD secrets exposure
  {
    category: 'cicd_leak',
    pattern:
      /\/(?:Jenkinsfile|\.gitlab-ci\.yml|\.travis\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml|appveyor\.yml|\.github\/workflows\/)/i,
    description: 'CI/CD pipeline config file probe (Jenkins/GitLab/Travis/etc)',
  },
  {
    category: 'cicd_leak',
    pattern:
      /\/(?:docker-compose\.ya?ml|Dockerfile(?:\.[a-z]+)?|\.dockerignore|k8s\/.*\.ya?ml|deployment\.ya?ml)$/i,
    description: 'Container/k8s manifest file probe',
  },

  // Cryptominer beacon
  {
    category: 'cryptominer_inject',
    pattern: /\/(?:coinhive\.min\.js|crypto-?(?:miner|loot|mine)|webminerpool|deepminer|jsecoin)/i,
    description: 'In-browser cryptominer asset probe',
  },

  // CMS scan (non-WordPress) — specifico marker files
  {
    category: 'cms_scan',
    pattern:
      /\/(?:CHANGELOG\.(?:txt|md)|INSTALL\.(?:txt|md)|MAINTAINERS\.(?:txt|md)|UPGRADE\.(?:txt|md))$/i,
    description: 'CMS source-code marker leak (Drupal/Joomla style)',
  },
  {
    category: 'cms_scan',
    pattern:
      /\/(?:joomla|drupal|magento|prestashop|opencart|typo3|shopify|sitecore|umbraco|kentico)(?:\/|$|\.)/i,
    description: 'CMS fingerprint probe (Joomla/Drupal/Magento/...)',
  },
  {
    category: 'cms_scan',
    pattern:
      /\/(?:user\/login|administrator\/index\.php|admin\/login\.php\?action=login|index\.php\?option=com_users)/i,
    description: 'CMS admin login endpoint enumeration',
  },

  // Injection patterns (query string-based, very specific)
  {
    category: 'sql_injection',
    pattern:
      /[?&][a-z_]+=(?:[0-9]+(?:%27|')\s*(?:OR|AND|UNION|SELECT|SLEEP|BENCHMARK)|UNION\s+(?:ALL\s+)?SELECT|';\s*(?:DROP|DELETE|UPDATE))/i,
    description: 'SQL injection payload signature',
  },
  {
    category: 'nosql_injection',
    pattern: /[?&][a-z_]+\[\$(?:gt|ne|lt|gte|lte|regex|where|in|nin|exists)\]/i,
    description: 'NoSQL operator injection (MongoDB syntax)',
  },
  {
    category: 'command_injection',
    pattern: /[?&](?:cmd|exec|system|command|run|do)=(?:[a-z]+|%6c%73|%63%61%74|%65%63%68%6f)/i,
    description: 'OS command injection via query param',
  },
  {
    category: 'command_injection',
    pattern: /[;|`$()](?:cat|ls|wget|curl|nc|bash|sh|whoami|id|uname|pwd)\b/i,
    description: 'Shell metacharacter injection in path/query',
  },
  {
    category: 'ssrf_probe',
    pattern:
      /[?&](?:url|redirect|next|target|dest|callback|return|continue)=(?:https?:\/\/|gopher:\/\/|file:\/\/|dict:\/\/|ftp:\/\/|jar:|netdoc:)/i,
    description: 'SSRF via query param with external/internal scheme',
  },
  {
    category: 'ssrf_probe',
    pattern: /\/(?:proxy|fetch|curl|wget)(?:\.php|\.aspx|\.jsp)?\?(?:url|uri|target)=/i,
    description: 'Open proxy endpoint probe',
  },

  // Extended env_leak (config files & secrets)
  {
    category: 'env_leak',
    pattern:
      /\/(?:config\.(?:json|ya?ml|toml|ini)|database\.ya?ml|secrets\.ya?ml|application\.properties|appsettings(?:\.[a-z]+)?\.json|\.npmrc|\.aws\/credentials|id_rsa|id_dsa|\.ssh\/(?:authorized_keys|known_hosts|config))$/i,
    description: 'Config / secrets / SSH key file probe',
  },

  // Extended info_disclosure (framework debug)
  {
    category: 'info_disclosure',
    pattern:
      /\/(?:debug\.html|debug\/default\/view|console\/login|_profiler\/(?:phpinfo|info)|app_dev\.php\/_profiler|_ignition\/health-check)/i,
    description: 'Framework debug toolbar / profiler probe',
  },

  // Path traversal extended (legacy CGI)
  {
    category: 'path_traversal',
    pattern: /\/(?:cgi-bin\/|nph-|cgi\/)/i,
    description: 'Legacy CGI script probe (often path traversal vector)',
  },

  // ────────────────────────────────────────────────────────────────
  // ORIGINAL v1 PATTERNS (broader, may be superseded by v2 above)
  // ────────────────────────────────────────────────────────────────

  // ─── .env / framework env file enumeration ─────────────────────
  {
    category: 'env_leak',
    pattern: /(?:^|\/)(?:\.env(?:rc|\.[a-z_]+)?|env\.backup)$/i,
    description: 'dotenv / direnv / env backup file probe',
  },
  {
    category: 'env_leak',
    pattern: /^\/[^/]+\/\.env$/i,
    description: 'framework dir + .env enum (zend, yii, wp, vue, vite, ...)',
  },

  // ─── WordPress fingerprint / brute-force ───────────────────────
  {
    category: 'wordpress_scan',
    pattern: /\/wp-(?:admin|login|config|content|includes|json)\//i,
    description: 'WordPress paths',
  },
  {
    category: 'wordpress_scan',
    pattern: /\/(?:wp-login|wp-admin\/install|xmlrpc)\.php$/i,
    description: 'WordPress entry points',
  },
  {
    category: 'wordpress_scan',
    pattern: /\/wlwmanifest\.xml$/i,
    description: 'Windows Live Writer manifest (WP fingerprint)',
  },

  // ─── Server-side script probes (PHP/ASP/JSP webshells) ─────────
  {
    category: 'shell_probe',
    pattern: /\.(?:php|asp|aspx|jsp|cgi|pl)(?:$|\?)/i,
    description: 'server-side script file probe',
  },

  // ─── VCS leak ──────────────────────────────────────────────────
  {
    category: 'vcs_leak',
    pattern: /\/\.(?:git|svn|hg|bzr)(?:\/|$)/i,
    description: '.git/.svn/.hg/.bzr directory exposure',
  },
  {
    category: 'vcs_leak',
    pattern: /\/\.git(?:ignore|config|attributes|modules|head)$/i,
    description: 'git metadata files',
  },
  {
    category: 'vcs_leak',
    pattern: /\/\.(?:htaccess|htpasswd|DS_Store)$/i,
    description: 'Apache/Mac metadata leak',
  },

  // ─── DB admin panels ───────────────────────────────────────────
  {
    category: 'admin_panel_probe',
    pattern: /\/(?:phpmyadmin|adminer|pma|dbadmin|mysql|webdav|webmail)(?:\/|$)/i,
    description: 'phpMyAdmin / Adminer / WebDAV probe',
  },

  // ─── DevOps tool exposure (CVE-rich attack surface) ────────────
  {
    category: 'devops_tool_probe',
    pattern:
      /\/(?:actuator|jenkins|gitlab|grafana|prometheus|kibana|elasticsearch|consul|vault|nomad)(?:\/|$)/i,
    description: 'DevOps / observability tool probe',
  },

  // ─── Auth bypass attempts ──────────────────────────────────────
  {
    category: 'auth_bypass_try',
    pattern: /\/(?:remote_login|saml\/sso\/login|cgi-bin\/login|owa\/auth)(?:\/|$)/i,
    description: 'auth-bypass URI probe',
  },

  // ─── LLM proxy abuse (server used as free OpenAI/Anthropic relay) ──
  {
    category: 'llm_proxy_abuse',
    pattern:
      /^\/(?:v1\/(?:chat\/completions|completions|embeddings|models)|openai\/|anthropic\/|gemini-pro\/|chatgpt\/api\/)/i,
    description: 'LLM provider API path probe (proxy abuse)',
  },

  // ─── Path traversal ────────────────────────────────────────────
  {
    category: 'path_traversal',
    pattern: /(?:\.\.[\\/]|%2e%2e[\\/%]|%252e%252e|\/etc\/passwd|\/proc\/self|\/var\/log\/)/i,
    description: 'directory traversal / system file leak',
  },

  // ─── CVE-specific path probes ──────────────────────────────────
  {
    category: 'cve_probe',
    pattern:
      /\/(?:struts2-rest|log4j[a-z-]*|spring-cloud|webgoat|cve-\d{4}-\d+|exploit\.[a-z]+|backdoor|c99\.php|r57\.php|shell\.php)(?:$|\/)/i,
    description: 'known CVE / exploit / webshell name',
  },

  // ─── Info disclosure / status pages ────────────────────────────
  {
    category: 'info_disclosure',
    pattern:
      /^\/(?:server-status|server-info|phpinfo\.php|info\.php|status\.php|\.well-known\/security\.txt\.bak)$/i,
    description: 'server status / phpinfo / debug page probe',
  },

  // ─── Vite dev-server enumeration (CVE-rich attack family) ──────
  // Vite dev espone `/@fs/<abs-path>` per servire file fuori dal docroot,
  // `/@id/` per virtual module IDs, `/@vite/client`, `/@react-refresh`.
  // In prod NON dovrebbero MAI essere richiesti — solo scanner che
  // testano se l'app gira accidentalmente in dev mode.
  {
    category: 'info_disclosure',
    pattern: /^\/@(?:fs|id|vite|react-refresh)(?:\/|$)/i,
    description: 'Vite dev-server internal route probe (CVE-2025-30208 family)',
  },

  // ─── EXPANSION patterns 2026-06-02 sono spostati IN CIMA al file
  //     per evitare che pattern shell_probe generico (.cgi/.php) catturi
  //     prima router_cve, iot, k8s, etc. Vedi blocco "SPECIFIC PATTERNS FIRST"
  //     all'inizio dell'array. I duplicati sono stati RIMOSSI.
]);

export interface HoneypotMatch {
  readonly category: HoneypotCategory;
  readonly description: string;
}

/**
 * Classify a request path. Returns the first matching pattern (categories
 * are mutually informative — multiple matches mean the same intent).
 *
 * Pre-strip query string before calling. Pre-lowercased is not required
 * (patterns use /i flag).
 */
export function classifyHoneypotPath(path: string): HoneypotMatch | null {
  if (!path || path.length === 0) return null;
  for (const p of HONEYPOT_PATTERNS) {
    if (p.pattern.test(path)) {
      return { category: p.category, description: p.description };
    }
  }
  return null;
}
