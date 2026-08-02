/**
 * AI Providers settings — tenant-scoped storage for LLM provider keys.
 *
 * Strategy: reuse the existing `credentials` table + envelope encryption
 * (AES-256-GCM). Each provider is stored as ONE credential per tenant with
 * `name = 'default'` and `provider = 'llm:<provider>'`. The metadata_json
 * carries `defaultModel` and `baseUrl`.
 *
 * Why reuse credentials? The encryption pipeline is already audited (vault
 * + master password + envelope), the DB schema exists, the audit log
 * already records key access. Avoid a second crypto path.
 *
 * Public surface:
 *   - list(tenantId)           → which providers have a key set
 *   - upsert(tenantId, opts)   → save a provider's key (encrypts on disk)
 *   - get(tenantId, provider)  → decrypt + return apiKey+model+baseUrl (server-side only)
 *   - remove(tenantId, provider)
 *
 * Liara is special: free-tier hosted by NHA, no apiKey required. It is
 * always "available" — list() returns hasKey=true for liara unconditionally.
 */

import { nanoid } from 'nanoid';
import { encryptSecret, decryptSecret, type EncryptedSecret } from '@medea/engine-secrets';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { AuditLogService } from './audit.service.js';
import { loadMaster } from './credentials.service.js';
import { isLiaraEnabled, liaraBaseUrl } from '@/config.js';

const audit = new AuditLogService();

export type LlmProvider =
  | 'liara'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'groq'
  | 'grok'
  | 'deepseek'
  | 'perplexity'
  | 'openrouter'
  | 'ollama'
  | 'voyage';

export const SUPPORTED_PROVIDERS: readonly LlmProvider[] = [
  'liara',
  'openai',
  'anthropic',
  'gemini',
  'grok',
  'deepseek',
  'perplexity',
  'mistral',
  'groq',
  'openrouter',
  'ollama',
  'voyage',
];

const PROVIDER_DOC: Record<LlmProvider, { label: string; freeTier: boolean; description: string; signupUrl?: string }> = {
  liara: {
    label: 'Liara (free tier)',
    freeTier: true,
    description: 'Modello self-hosted Zeli SRL (Qwen3-VL-32B testo+vision, FP8 su Blackwell GPU). Nessuna API key richiesta.',
  },
  openai: { label: 'OpenAI (ChatGPT)', freeTier: false, description: 'GPT-4o, GPT-4.1, o1, ecc.', signupUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic Claude', freeTier: false, description: 'Claude Sonnet/Opus/Haiku.', signupUrl: 'https://console.anthropic.com/' },
  gemini: { label: 'Google Gemini', freeTier: false, description: 'Gemini 2.0 Flash / Pro.', signupUrl: 'https://aistudio.google.com/apikey' },
  grok: { label: 'Grok (X.AI)', freeTier: false, description: 'Grok 2 / Grok 3 by X.AI.', signupUrl: 'https://console.x.ai/' },
  deepseek: { label: 'DeepSeek', freeTier: false, description: 'DeepSeek Chat / Coder / V3.', signupUrl: 'https://platform.deepseek.com/api_keys' },
  perplexity: { label: 'Perplexity (Sonar)', freeTier: false, description: 'Sonar / Sonar Pro con web search integrata (risposte con citazioni live).', signupUrl: 'https://www.perplexity.ai/settings/api' },
  mistral: { label: 'Mistral AI', freeTier: false, description: 'Mistral Large / Medium / Small.', signupUrl: 'https://console.mistral.ai/' },
  groq: { label: 'Groq (LPU)', freeTier: false, description: 'Llama 3.3 70B su LPU dedicata (free tier disponibile).', signupUrl: 'https://console.groq.com/' },
  openrouter: { label: 'OpenRouter (gateway 100+ modelli)', freeTier: false, description: 'Gateway unificato — porta il tuo modello preferito specificando model="vendor/name".', signupUrl: 'https://openrouter.ai/keys' },
  // freeTier: false — Ollama richiede installazione locale dell'utente +
  // configurazione baseUrl in Settings. Senza credenziale registrata NON
  // appare nel dropdown (UX: niente provider non-disponibili).
  ollama: { label: 'Ollama (locale)', freeTier: false, description: 'LLM locale self-hosted. Usa baseUrl per puntare al tuo Ollama (default: http://localhost:11434).' },
  voyage: { label: 'Voyage AI (embeddings)', freeTier: false, description: 'Embeddings per RAG.', signupUrl: 'https://dash.voyageai.com/' },
};

interface CredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  provider: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  dek_ciphertext: string;
  dek_nonce: string;
  dek_auth_tag: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ProviderMeta {
  defaultModel?: string;
  baseUrl?: string;
}

export interface ProviderListEntry {
  provider: LlmProvider;
  label: string;
  freeTier: boolean;
  description: string;
  signupUrl?: string;
  hasKey: boolean;
  defaultModel?: string;
  baseUrl?: string;
  updatedAt?: string;
}

const KEY_PREFIX = 'llm:';
// NB: niente più SLOT_NAME costante — le righe LLM sono keyate per `provider`
// (`llm:<p>`) e il `name` è per-provider (= storageKey) per soddisfare
// UNIQUE(tenant_id, name) e permettere TUTTI i provider per tenant (bug 2026-06-17).

function providerToStorageKey(p: LlmProvider): string {
  return `${KEY_PREFIX}${p}`;
}

export class LlmProvidersService {
  list(tenantId = 'default'): ProviderListEntry[] {
    const { sqlite } = getDatabase();
    // Le righe LLM-provider sono identificate dalla colonna `provider` (`llm:<p>`),
    // NON dal `name`: ogni provider è una riga distinta. (Vedi nota su upsert: il
    // `name` è per-provider per soddisfare UNIQUE(tenant_id,name) — un tenant può
    // avere TUTTI i provider, non uno solo. Bug 2026-06-17.)
    const rows = sqlite
      .prepare('SELECT provider, metadata_json, updated_at FROM user_credentials WHERE tenant_id = ? AND provider LIKE ?')
      .all(tenantId, `${KEY_PREFIX}%`) as { provider: string; metadata_json: string | null; updated_at: string }[];

    const byProvider = new Map<string, { metadata: ProviderMeta; updatedAt: string }>();
    for (const r of rows) {
      let meta: ProviderMeta = {};
      try { meta = r.metadata_json ? (JSON.parse(r.metadata_json) as ProviderMeta) : {}; } catch { /* ignore */ }
      byProvider.set(r.provider, { metadata: meta, updatedAt: r.updated_at });
    }

    // On-prem builds (MEDEA_DISABLE_LIARA=true) hide liara from the list
    // entirely — the admin must configure a different provider.
    const liaraOk = isLiaraEnabled();
    const visibleProviders = liaraOk ? SUPPORTED_PROVIDERS : SUPPORTED_PROVIDERS.filter((p) => p !== 'liara');

    return visibleProviders.map((p) => {
      const stored = byProvider.get(providerToStorageKey(p));
      const doc = PROVIDER_DOC[p];
      const hasKey = (p === 'liara' && liaraOk) || stored !== undefined;
      const entry: ProviderListEntry = {
        provider: p,
        label: doc.label,
        freeTier: doc.freeTier,
        description: doc.description,
        hasKey,
      };
      if (doc.signupUrl) entry.signupUrl = doc.signupUrl;
      if (stored?.metadata.defaultModel) entry.defaultModel = stored.metadata.defaultModel;
      if (stored?.metadata.baseUrl) entry.baseUrl = stored.metadata.baseUrl;
      if (stored?.updatedAt) entry.updatedAt = stored.updatedAt;
      return entry;
    });
  }

  async upsert(tenantId: string, provider: LlmProvider, opts: { apiKey: string; defaultModel?: string; baseUrl?: string; actorId?: string }): Promise<void> {
    if (provider === 'liara') {
      // Liara is free-tier, no key needed. Still allow saving defaultModel as a preference.
      if (!opts.defaultModel) return;
    } else if (!opts.apiKey || opts.apiKey.trim() === '') {
      throw new Error(`apiKey richiesta per provider ${provider}`);
    }

    const master = loadMaster();
    const storageKey = providerToStorageKey(provider);
    const { sqlite } = getDatabase();
    const now = new Date().toISOString();

    // Identità della riga = (tenant_id, provider). Il `name` è per-provider
    // (= storageKey) così UNIQUE(tenant_id, name) ammette UNA riga PER PROVIDER
    // (col vecchio name costante 'default' il 2° provider violava il vincolo →
    // un solo provider per tenant, bug 2026-06-17). La tabella è condivisa con le
    // credenziali generali, quindi NON tocchiamo il vincolo: rendiamo univoco il name.
    const rowName = storageKey;
    const existing = sqlite
      .prepare('SELECT id FROM user_credentials WHERE tenant_id = ? AND provider = ?')
      .get(tenantId, storageKey) as { id?: string } | undefined;

    const meta: ProviderMeta = {};
    if (opts.defaultModel !== undefined && opts.defaultModel !== '') meta.defaultModel = opts.defaultModel;
    if (opts.baseUrl !== undefined && opts.baseUrl !== '') meta.baseUrl = opts.baseUrl;
    const metadataJson = JSON.stringify(meta);

    const plaintext = opts.apiKey || ' ';
    const id = existing?.id ?? nanoid();
    // name = rowName (per-provider): è anche AAD della cifratura. get() decritta
    // con row.name (non hardcoded) → coerente. Su UPDATE risaniamo anche il name
    // (legacy 'default' → storageKey) ri-cifrando con la nuova AAD.
    const enc = encryptSecret(
      { id, tenantId, name: rowName, provider: storageKey, plaintext },
      master,
    );

    if (existing?.id) {
      sqlite
        .prepare(
          'UPDATE user_credentials SET name = ?, ciphertext = ?, nonce = ?, auth_tag = ?, dek_ciphertext = ?, dek_nonce = ?, dek_auth_tag = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
        )
        .run(rowName, enc.ciphertext, enc.nonce, enc.authTag, enc.dekCiphertext, enc.dekNonce, enc.dekAuthTag, metadataJson, now, existing.id);
    } else {
      sqlite
        .prepare(
          'INSERT INTO user_credentials (id, tenant_id, name, provider, ciphertext, nonce, auth_tag, dek_ciphertext, dek_nonce, dek_auth_tag, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, tenantId, rowName, storageKey, enc.ciphertext, enc.nonce, enc.authTag, enc.dekCiphertext, enc.dekNonce, enc.dekAuthTag, metadataJson, now, now);
    }

    // #208 P0-9: await — audit durable.
    await audit.append({
      tenantId,
      action: 'llm_provider.upsert',
      resourceType: 'llm_provider',
      resourceId: provider,
      ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
      metadata: { provider, hasModel: !!opts.defaultModel },
    });

    logger.info({ tenantId, provider }, 'LLM provider settings updated');
  }

  /**
   * Server-side decrypt — returns the plaintext apiKey + metadata for the
   * runtime to use when executing AI nodes. NEVER expose this over HTTP.
   */
  get(tenantId: string, provider: LlmProvider): { apiKey: string; defaultModel?: string; baseUrl?: string } | null {
    if (provider === 'liara') {
      // Free tier — no key, server uses the (configurable) Liara endpoint.
      // BUT: when on-prem decoupling is enabled, treat as if not configured
      // so the fallback chain skips it cleanly.
      if (!isLiaraEnabled()) return null;
      return { apiKey: '', baseUrl: liaraBaseUrl() };
    }
    const { sqlite } = getDatabase();
    const storageKey = providerToStorageKey(provider);
    const row = sqlite
      .prepare('SELECT * FROM user_credentials WHERE tenant_id = ? AND provider = ?')
      .get(tenantId, storageKey) as CredentialRow | undefined;
    if (!row) return null;

    const enc: EncryptedSecret = {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      provider: row.provider,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
      dekCiphertext: row.dek_ciphertext,
      dekNonce: row.dek_nonce,
      dekAuthTag: row.dek_auth_tag,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const master = loadMaster();
    const apiKey = decryptSecret(enc, master).trim();

    let meta: ProviderMeta = {};
    if (row.metadata_json) {
      try { meta = JSON.parse(row.metadata_json) as ProviderMeta; } catch { /* ignore */ }
    }

    const result: { apiKey: string; defaultModel?: string; baseUrl?: string } = { apiKey };
    if (meta.defaultModel) result.defaultModel = meta.defaultModel;
    if (meta.baseUrl) result.baseUrl = meta.baseUrl;
    return result;
  }

  /**
   * Load all configured providers for a tenant in one shot — used by the
   * workflow engine to inject `context.llmProviders` into the executor.
   */
  getAll(tenantId: string): Partial<Record<LlmProvider, { apiKey: string; defaultModel?: string; baseUrl?: string }>> {
    const out: Partial<Record<LlmProvider, { apiKey: string; defaultModel?: string; baseUrl?: string }>> = {};
    for (const p of SUPPORTED_PROVIDERS) {
      const cfg = this.get(tenantId, p);
      if (cfg) out[p] = cfg;
    }
    return out;
  }

  async remove(tenantId: string, provider: LlmProvider, actorId?: string): Promise<boolean> {
    if (provider === 'liara') return false; // can't "delete" the free tier
    const { sqlite } = getDatabase();
    const storageKey = providerToStorageKey(provider);
    const info = sqlite
      .prepare('DELETE FROM user_credentials WHERE tenant_id = ? AND provider = ?')
      .run(tenantId, storageKey);
    if (info.changes > 0) {
      // #208 P0-9: await — audit durable.
      await audit.append({
        tenantId,
        action: 'llm_provider.remove',
        resourceType: 'llm_provider',
        resourceId: provider,
        ...(actorId !== undefined ? { actorId } : {}),
        metadata: { provider },
      });
    }
    return info.changes > 0;
  }
}
