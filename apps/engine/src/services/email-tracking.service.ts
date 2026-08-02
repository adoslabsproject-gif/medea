/**
 * Email tracking sink — open pixel + click redirect.
 *
 * The `action_email_send_tracked` node stamps every outgoing email with
 * an HMAC-signed token (see `@medea/engine-nodes-stdlib/lib/email-tracking-token`).
 * When the recipient opens the email or clicks a link, their browser
 * (or mail client) hits one of two endpoints on this runtime:
 *
 *   GET /api/track/open/:token              → 1×1 GIF
 *   GET /api/track/click/:token?u=<dest>    → 302 redirect
 *
 * For each hit we:
 *
 *   1. Verify the HMAC and decode the payload (workspace, lead, campaign, send).
 *   2. Reject bots (Gmail/Yahoo proxies, Office365 SafeLinks, scanners).
 *   3. Insert into `b2b_interactions` so the downstream lead-scoring
 *      workflow can roll up `score += 10` per open, `+20` per click,
 *      `+40` per reply.
 *   4. For clicks: validate the destination URL is http/https — refuse
 *      `javascript:` / `data:` redirects (open-redirect to script exec).
 *
 * Performance posture: each hit is a single INSERT with an integer
 * column on a tenant SQLite — sub-millisecond at expected volumes
 * (hundreds of hits per minute peak during a campaign blast).
 *
 * @module services/email-tracking.service
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, type SqliteCompatProxy } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';
import { verifyTrackingToken, isTrackingBot } from '@medea/engine-nodes-stdlib/server';
import type { EmailTrackingPayload, VerifyFailReason } from '@medea/engine-nodes-stdlib';

const log = (extra: Record<string, unknown>): void => {
  logger.info({ component: 'email-tracking', ...extra });
};

export interface RecordOpenArgs {
  token: string;
  userAgent: string | undefined;
  ip: string | undefined;
  secret: string;
}

export interface RecordClickArgs {
  token: string;
  destinationUrl: string;
  userAgent: string | undefined;
  ip: string | undefined;
  secret: string;
}

export type RecordResult =
  | { ok: true; payload: EmailTrackingPayload; recorded: boolean; bot: boolean }
  | { ok: false; reason: VerifyFailReason | 'bad-destination' };

/**
 * Record an open. Returns whether we actually persisted the row (we
 * skip persistence for bot-UAs but still return ok so the endpoint can
 * respond with a real GIF — refusing the GIF would tip off scanners).
 */
export async function recordOpen(args: RecordOpenArgs): Promise<RecordResult> {
  const verified = await verifyTrackingToken(args.token, args.secret, { expectedKind: 'open' });
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const bot = isTrackingBot(args.userAgent);
  if (bot) {
    log({ kind: 'open', reason: 'bot-skipped', ua: args.userAgent, leadId: verified.payload.l });
    return { ok: true, payload: verified.payload, recorded: false, bot: true };
  }
  insertInteraction(getDatabase().sqlite, {
    tenantId: verified.payload.w,
    leadId: verified.payload.l,
    campaignId: verified.payload.c,
    sendId: verified.payload.s,
    type: 'email_open',
    payload: { ua: args.userAgent, ip_hash: hashIp(args.ip) },
  });
  return { ok: true, payload: verified.payload, recorded: true, bot: false };
}

/**
 * Record a click + return the validated destination URL for the 302.
 * Refuses non-http(s) schemes — the destination travels in the URL query
 * string and an attacker may try to inject `javascript:` / `data:` to
 * pivot a tracked redirect into script execution.
 */
export async function recordClick(args: RecordClickArgs): Promise<RecordResult> {
  const verified = await verifyTrackingToken(args.token, args.secret, { expectedKind: 'click' });
  if (!verified.ok) return { ok: false, reason: verified.reason };

  let destUrl: URL;
  try {
    destUrl = new URL(args.destinationUrl);
  } catch {
    return { ok: false, reason: 'bad-destination' };
  }
  if (destUrl.protocol !== 'http:' && destUrl.protocol !== 'https:') {
    return { ok: false, reason: 'bad-destination' };
  }

  const bot = isTrackingBot(args.userAgent);
  if (bot) {
    log({ kind: 'click', reason: 'bot-skipped', ua: args.userAgent, leadId: verified.payload.l });
    return { ok: true, payload: verified.payload, recorded: false, bot: true };
  }
  insertInteraction(getDatabase().sqlite, {
    tenantId: verified.payload.w,
    leadId: verified.payload.l,
    campaignId: verified.payload.c,
    sendId: verified.payload.s,
    type: 'email_click',
    payload: {
      ua: args.userAgent,
      ip_hash: hashIp(args.ip),
      url: destUrl.toString(),
      i: verified.payload.i,
    },
  });
  return { ok: true, payload: verified.payload, recorded: true, bot: false };
}

interface InsertArgs {
  tenantId: string;
  leadId: string;
  campaignId: string;
  sendId: string;
  type: 'email_open' | 'email_click';
  payload: Record<string, unknown>;
}

function insertInteraction(db: SqliteCompatProxy, args: InsertArgs): void {
  try {
    db.prepare(
      `INSERT INTO b2b_interactions (id, tenant_id, lead_id, campaign_id, send_id, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      args.tenantId,
      args.leadId,
      args.campaignId,
      args.sendId,
      args.type,
      JSON.stringify(args.payload),
    );
  } catch (err) {
    // The tracking endpoints MUST never throw — a failed INSERT just means
    // we drop one analytics datapoint. The user still gets their pixel /
    // redirect. We log so the operator can chase a misconfigured tenant.
    logger.error({ err, args, component: 'email-tracking' }, 'INSERT b2b_interactions failed');
  }
}

/**
 * One-way IP hash. We do NOT store raw IPs — GDPR posture: the IP is a
 * "personal data" identifier and the analytics use-case doesn't need to
 * reverse it. We keep enough entropy to dedup a single IP across opens
 * during a short window (anti-double-counting on F5 spam).
 */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`flowforge-track-ip-v1:${ip}`).digest('hex').slice(0, 16);
}

/** Single transparent 1×1 GIF (43 bytes, RFC-classic). Exposed for tests + route. */
export const TRANSPARENT_GIF_BYTES = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x01, 0x00, 0x01, 0x00,                         // 1×1
  0x80, 0x00, 0x00,                               // packed
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // palette
  0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, // graphic control
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,       // image descriptor
  0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, // image data
  0x3b,                                             // trailer
]);
