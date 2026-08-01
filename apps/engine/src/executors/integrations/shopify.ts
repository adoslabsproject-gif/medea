/**
 * Shopify executor — Admin REST API 2024-01 (token-based, X-Shopify-Access-Token).
 *
 * Operazioni: createOrder, getOrder, listProducts, createProduct, adjustInventory.
 * Credenziali nel vault tenant: { shopDomain, accessToken } (Admin API access token,
 * `shpat_...`). Tutto l'HTTP passa per jsonFetch → safeOutboundFetch (SSRF + breaker
 * + timeout) + withRetry su 5xx/network. Errori tipizzati IntegrationError.
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel, parseJsonObj } from './saas-shared.js';

interface ShopifyCreds { shopDomain?: string; accessToken?: string }

const API_VERSION = '2024-01';

function shopBase(domain: string): string {
  const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(d)) {
    throw new IntegrationError({ provider: 'shopify', code: 'INVALID_PAYLOAD', message: `shopDomain non valido: "${domain}" (atteso <store>.myshopify.com)` });
  }
  return `https://${d}/admin/api/${API_VERSION}`;
}

export const shopifyExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'getOrder');

  const integ = requireIntegration({ provider: 'shopify', tenantId: context.tenantId, label: getIntegrationLabel(cfg) });
  const creds = integ.credentials as ShopifyCreds;
  if (!creds.shopDomain || !creds.accessToken) {
    throw new IntegrationError({ provider: 'shopify', code: 'INVALID_CREDENTIALS', message: 'shopDomain o accessToken assente nel vault' });
  }
  const base = shopBase(creds.shopDomain);
  const headers = { 'X-Shopify-Access-Token': creds.accessToken };

  let output: Record<string, unknown> = {};

  await withRetry(async () => {
    switch (operation) {
      case 'getOrder': {
        const orderId = coerceString(cfg.orderId ?? '').trim();
        if (!orderId) throw new IntegrationError({ provider: 'shopify', code: 'INVALID_PAYLOAD', message: 'orderId obbligatorio per getOrder' });
        const r = await jsonFetch<{ order?: Record<string, unknown> }>(
          'shopify', `${base}/orders/${encodeURIComponent(orderId)}.json`, null,
          { method: 'GET', headers },
        );
        output = { order: r.order ?? null };
        break;
      }
      case 'createOrder': {
        const orderBody = parseJsonObj('shopify', cfg.orderJson, 'orderJson');
        if (Object.keys(orderBody).length === 0) throw new IntegrationError({ provider: 'shopify', code: 'INVALID_PAYLOAD', message: 'orderJson obbligatorio per createOrder' });
        const r = await jsonFetch<{ order?: { id?: number } }>(
          'shopify', `${base}/orders.json`, null,
          { method: 'POST', body: { order: orderBody }, headers },
        );
        output = { orderId: r.order?.id ?? null, order: r.order ?? null };
        break;
      }
      case 'listProducts': {
        const limit = Math.min(Math.max(Number(cfg.limit ?? 50), 1), 250);
        const r = await jsonFetch<{ products?: unknown[] }>(
          'shopify', `${base}/products.json?limit=${String(limit)}`, null,
          { method: 'GET', headers },
        );
        const products = Array.isArray(r.products) ? r.products : [];
        output = { products, count: products.length };
        break;
      }
      case 'createProduct': {
        const productBody = parseJsonObj('shopify', cfg.productJson, 'productJson');
        if (Object.keys(productBody).length === 0) throw new IntegrationError({ provider: 'shopify', code: 'INVALID_PAYLOAD', message: 'productJson obbligatorio per createProduct' });
        const r = await jsonFetch<{ product?: { id?: number } }>(
          'shopify', `${base}/products.json`, null,
          { method: 'POST', body: { product: productBody }, headers },
        );
        output = { productId: r.product?.id ?? null, product: r.product ?? null };
        break;
      }
      default:
        throw new IntegrationError({ provider: 'shopify', code: 'INVALID_PAYLOAD', message: `operation "${operation}" non supportata (getOrder/createOrder/listProducts/createProduct)` });
    }
  }, { label: `shopify.${operation}` });

  return { output: { ok: true, operation, ...output }, durationMs: Date.now() - start };
};
