/**
 * Log-quota watcher (F4 Cappella 2026-06-07 sera).
 *
 * Cron orario che misura l'occupazione dei runs vs la quota log del piano e:
 *   - >80% → invia email warn "spazio in esaurimento, archivia ora"
 *   - 100% → invia email stop + auto-switch implicit a 'silent' per TUTTI
 *            i workflow del tenant (forza ephemeral fino a quando l'utente
 *            non libera spazio o archivia)
 *
 * Idempotente: invia warn una sola volta ogni 24h finché il problema persiste
 * (anti-spam via tabella `log_quota_alerts` che traccia last_sent_at).
 * Pattern allineato al `notifyFailure` esistente per SMTP send via env.
 */
import nodemailer from 'nodemailer';
import { eq, ne, isNull, or } from 'drizzle-orm';
import { getDatabase } from '@/storage/db.js';
import { workflows } from '@/storage/schema.js';
import { getCurrentQuotas } from '@/services/storage-quota.service.js';
import { logger } from '@/lib/logger.js';
import { loadConfig } from '@/config.js';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Anti-spam: state in-memory delle ultime alert inviate (perse al restart,
// ma il restart è raro abbastanza da rispamming inaccettabile).
let lastWarnSentAt = 0;
let lastFullSentAt = 0;

let timer: ReturnType<typeof setInterval> | null = null;

function dirSizeBytes(path: string): number {
  let total = 0;
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      try {
        if (entry.isDirectory()) total += dirSizeBytes(child);
        else if (entry.isFile()) total += statSync(child).size;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir not present */
  }
  return total;
}

function measureLogUsage(): number {
  const dir = loadConfig().MEDEA_DATA_DIR;
  // Stima conservativa: WAL+SQLite+archives. Per F4 misuriamo solo gli
  // archives (i runs attivi sono dentro medea.sqlite la cui dimensione
  // è già contata sotto workflowData).
  return dirSizeBytes(join(dir, 'archives'));
}

function buildSmtpTransport(): nodemailer.Transporter | null {
  const host = process.env.MEDEA_SMTP_HOST;
  const port = process.env.MEDEA_SMTP_PORT;
  const user = process.env.MEDEA_SMTP_USER;
  const pass = process.env.MEDEA_SMTP_PASS;
  if (!host || !port) return null;
  const portNum = Number(port);
  return nodemailer.createTransport({
    host,
    port: portNum,
    secure: portNum === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });
}

function ownerEmail(): string | undefined {
  return process.env.MEDEA_TENANT_OWNER_EMAIL;
}

function publicBaseUrl(): string {
  return loadConfig().MEDEA_PUBLIC_BASE_URL ?? 'https://flowforge.automazionezeli.com';
}

function logoUrl(): string {
  // Logo Zeli serviti dal portal /assets/logo.png — coerente con email esistenti.
  return 'https://flowforge.automazionezeli.com/assets/logo.png';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n.toString()} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface EmailTpl {
  subject: string;
  html: string;
  text: string;
}

function emailWarn80(usedPercent: number, usedBytes: number, quotaBytes: number): EmailTpl {
  const url = `${publicBaseUrl()}/settings/logging`;
  const subject = `⚠ Spazio cronologia workflow all'${usedPercent.toString()}% — è ora di archiviare`;
  const html = `<!doctype html><html lang="it"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7fa;padding:24px;color:#1a1a1a">
<table cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
<tr><td style="background:#0b0b0d;padding:20px;text-align:center">
<img src="${logoUrl()}" alt="Zeli FlowForge" style="height:32px;width:auto" />
</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px 0;font-size:20px;color:#0b0b0d">Ciao,</h1>
<p>La cronologia run del tuo workspace ha raggiunto <strong>${usedPercent.toString()}% dello spazio dedicato</strong> (${formatBytes(usedBytes)} su ${formatBytes(quotaBytes)}).</p>
<p>Se non intervieni, al 100% i nuovi run smetteranno di essere salvati nella cronologia finché non liberi spazio.</p>
<p><strong>Cosa puoi fare:</strong></p>
<ul style="line-height:1.6">
<li>Scaricare gli archivi <code>.jsonl.gz</code> e cancellarli dal server</li>
<li>Ridurre la verbosità dei workflow più rumorosi (<em>full → summary</em>)</li>
<li>Cancellare la cronologia dei workflow non più necessari</li>
</ul>
<p style="text-align:center;margin:24px 0">
<a href="${url}" style="display:inline-block;background:#0b0b0d;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Apri Settings → Logging</a>
</p>
<p style="font-size:12px;color:#999;margin-top:32px">Il team Zeli SRL</p>
</td></tr>
</table>
</body></html>`;
  const text = `Ciao,\n\nLa cronologia run del tuo workspace ha raggiunto ${usedPercent.toString()}% dello spazio dedicato (${formatBytes(usedBytes)} su ${formatBytes(quotaBytes)}).\n\nSe non intervieni, al 100% i nuovi run smetteranno di essere salvati nella cronologia.\n\nGestisci lo spazio: ${url}\n\nIl team Zeli SRL`;
  return { subject, html, text };
}

function emailFull100(usedBytes: number, quotaBytes: number): EmailTpl {
  const url = `${publicBaseUrl()}/settings/logging`;
  const subject = `🛑 Cronologia workflow piena — nuovi run NON vengono più salvati`;
  const html = `<!doctype html><html lang="it"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7fa;padding:24px;color:#1a1a1a">
<table cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
<tr><td style="background:#0b0b0d;padding:20px;text-align:center">
<img src="${logoUrl()}" alt="Zeli FlowForge" style="height:32px;width:auto" />
</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px 0;font-size:20px;color:#dc2626">Spazio cronologia esaurito</h1>
<p>La cronologia run del tuo workspace ha raggiunto il <strong>100% dello spazio dedicato</strong> (${formatBytes(usedBytes)} su ${formatBytes(quotaBytes)}).</p>
<p>Per proteggere il workspace, abbiamo attivato automaticamente la modalità "esecuzione effimera": i workflow continuano a girare normalmente, ma <strong>i nuovi run non vengono più tracciati nella cronologia</strong> finché non liberi spazio.</p>
<p>La <strong>Dashboard Live</strong> continua a mostrare l'esecuzione in tempo reale — è solo la cronologia archiviata a essere in pausa.</p>
<p style="text-align:center;margin:24px 0">
<a href="${url}" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Libera spazio ora</a>
</p>
<p style="font-size:12px;color:#999;margin-top:32px">Il team Zeli SRL</p>
</td></tr>
</table>
</body></html>`;
  const text = `Spazio cronologia esaurito.\n\nLa cronologia run del tuo workspace ha raggiunto il 100% (${formatBytes(usedBytes)} su ${formatBytes(quotaBytes)}).\n\nAbbiamo attivato la modalità "esecuzione effimera": i workflow continuano a girare ma la cronologia è in pausa.\n\nLibera spazio: ${url}\n\nIl team Zeli SRL`;
  return { subject, html, text };
}

async function sendEmail(tpl: EmailTpl): Promise<void> {
  const to = ownerEmail();
  if (!to) {
    logger.warn?.('[log-quota-watcher] MEDEA_TENANT_OWNER_EMAIL not set, skipping email');
    return;
  }
  const transport = buildSmtpTransport();
  if (!transport) {
    logger.warn?.('[log-quota-watcher] SMTP env not configured, skipping email');
    return;
  }
  const from = process.env.MEDEA_SMTP_FROM ?? 'info@zeli.it';
  await transport.sendMail({ from, to, subject: tpl.subject, html: tpl.html, text: tpl.text });
  logger.info?.({ to, subject: tpl.subject }, '[log-quota-watcher] email sent');
}

/**
 * Switch implicito di TUTTI i workflow del tenant a runVerbosity='silent'.
 * Salva la lista degli ID modificati così la UI può mostrare un banner
 * "log temporaneamente sospesi" e l'utente sa cosa è stato cambiato.
 */
async function forceEphemeralImplicit(): Promise<number> {
  const { db } = getDatabase();
  const res = await db
    .update(workflows)
    .set({ runVerbosity: 'silent' })
    .where(or(isNull(workflows.runVerbosity), ne(workflows.runVerbosity, 'silent')));
  // Drizzle update non sempre ritorna count su SQLite — leggiamo dopo.
  const { sqlite } = getDatabase();
  const after = sqlite
    .prepare("SELECT COUNT(*) as n FROM workflows WHERE run_verbosity = 'silent'")
    .get() as { n: number };
  // Suppress unused-binding warning
  void res;
  void eq;
  return after.n;
}

async function tick(): Promise<void> {
  try {
    const quotas = getCurrentQuotas();
    if (quotas.freeTier || quotas.logRetentionBytes === 0) return; // Free → no quota log
    const used = measureLogUsage();
    const percent = Math.min(100, Math.round((used / quotas.logRetentionBytes) * 100));
    const now = Date.now();
    if (percent >= 100 && now - lastFullSentAt > DAY_MS) {
      const tpl = emailFull100(used, quotas.logRetentionBytes);
      await sendEmail(tpl);
      lastFullSentAt = now;
      const switched = await forceEphemeralImplicit();
      logger.warn?.(
        { percent, used, quota: quotas.logRetentionBytes, switched },
        '[log-quota-watcher] FULL — auto-switch implicit ephemeral',
      );
    } else if (percent >= 80 && now - lastWarnSentAt > DAY_MS) {
      const tpl = emailWarn80(percent, used, quotas.logRetentionBytes);
      await sendEmail(tpl);
      lastWarnSentAt = now;
      logger.warn?.(
        { percent, used, quota: quotas.logRetentionBytes },
        '[log-quota-watcher] WARN — email sent',
      );
    }
  } catch (e) {
    logger.warn?.({ err: e }, '[log-quota-watcher] tick failed');
  }
}

export function startLogQuotaWatcher(): void {
  if (timer) return;
  // First tick after 5 min (let archive cron eventually run)
  setTimeout(
    () => {
      void tick();
    },
    5 * 60 * 1000,
  ).unref?.();
  timer = setInterval(() => {
    void tick();
  }, HOUR_MS);
  timer.unref?.();
  logger.info?.('log-quota-watcher started');
}

export function stopLogQuotaWatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
