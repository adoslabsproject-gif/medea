/**
 * PEC Aruba RECEIVE — IMAP polling executor.
 * Connects to imaps.pec.aruba.it (or custom host), fetches up to N unread
 * messages matching an optional subject regex, scarica il SOURCE completo e lo
 * parsa (mailparser) in output strutturato PEC: { messageId, from, to, subject,
 * body, attachments[], pecHeaders, pecType }. Also wired into
 * TriggerWatchersService for trigger-style usage.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { type NodeExecutor, safeUserRegex } from '@medea/engine-nodes-stdlib';
import { buildPecMessage, type PecParsedMessage } from './pec/pec-message.js';
import { assertConnectHostAllowed } from '@/lib/connect-host-guard.js';

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export const pecArubaReceiveExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const username = asString(config.username);
  const password = asString(config.password);
  const host = asString(config.host) || 'imaps.pec.aruba.it';
  const port = Number(config.port ?? 993);
  const mailbox = asString(config.mailbox) || 'INBOX';
  const max = Number(config.maxMessages ?? 50);
  const filterSubject = asString(config.filterSubject);
  if (!username || !password) throw new Error('italia_pec_aruba_receive: username/password required');
  assertConnectHostAllowed(host, 'PEC IMAP'); // SSRF: host da config → no rete interna

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: username, pass: password },
    logger: false,
  });

  await client.connect();
  const result: PecParsedMessage[] = [];
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const subjectRegex = filterSubject ? safeUserRegex(filterSubject) : null;
      // source:true → mailparser può estrarre body + allegati + header PEC.
      const fetched = client.fetch({ seen: false }, { envelope: true, source: true });
      for await (const message of fetched) {
        const subject = message.envelope?.subject ?? '';
        if (subjectRegex && !subjectRegex.test(subject)) continue;
        if (message.source) {
          const parsed = await simpleParser(message.source);
          result.push(buildPecMessage(parsed));
        }
        if (result.length >= max) break;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { output: { count: result.length, messages: result, mailbox }, durationMs: Date.now() - start };
};
