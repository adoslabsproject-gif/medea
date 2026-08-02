/**
 * Tests 2026-grade per buildNodeCatalog + helpers.
 *
 * FIX 2026-05-30 user-segnalato: Liara wizard faceva abort
 *   "defId community_telegram non nel catalogo"
 * anche se i 7 community v2.0 erano caricati via loadInstalledFromDisk
 * (log count:7). Causa: buildNodeCatalog leggeva SOLO ALL_NODE_MODULES
 * (statico, bundled) ignorando i community runtime-loaded.
 *
 * Fix: buildNodeCatalog ora UNISCE bundled + community via listInstalled().
 * REGRESSION test: catalog include community_<vendor> con sub-actions visibili.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock listInstalled() per controllare l'array community in test.
const listInstalledMock = vi.fn(() => [] as { def: unknown }[]);
vi.mock('@/services/community-nodes.service.js', () => ({
  listInstalled: () => listInstalledMock(),
}));

// Mock ALL_NODE_MODULES per evitare side-effect engine boot in jsdom.
vi.mock('@/engine/workflow-engine.js', () => ({
  ALL_NODE_MODULES: [
    {
      def: {
        id: 'action_send_email',
        type: 'action',
        label: 'Send Email',
        description: 'Invia email via SMTP',
        configFields: [
          { key: 'to', label: 'Destinatario', type: 'expression', required: true },
          { key: 'subject', label: 'Oggetto', type: 'expression', required: true },
        ],
      },
    },
    {
      def: {
        id: 'trigger_imap',
        type: 'trigger',
        label: 'IMAP Trigger',
        description: 'Polling IMAP',
        configFields: [
          { key: 'accountId', label: 'Account', type: 'email-account-picker', required: true },
        ],
      },
    },
  ],
}));

import {
  buildNodeCatalog,
  normalizeColumnType,
  normalizeConstraints,
  ALLOWED_COLUMN_TYPES,
} from './node-catalog.js';

beforeEach(() => {
  listInstalledMock.mockReset();
  listInstalledMock.mockReturnValue([]);
});

describe('buildNodeCatalog — bundled only', () => {
  it('senza community → include solo ALL_NODE_MODULES (action_send_email + trigger_imap)', () => {
    const cat = buildNodeCatalog();
    const ids = cat.map((c) => c.defId);
    expect(ids).toContain('action_send_email');
    expect(ids).toContain('trigger_imap');
    expect(cat).toHaveLength(2);
  });

  it('mappa configFields correttamente (key/label/type/required preservati)', () => {
    const cat = buildNodeCatalog();
    const email = cat.find((c) => c.defId === 'action_send_email');
    expect(email).toBeDefined();
    expect(email?.fields).toHaveLength(2);
    expect(email?.fields[0]).toEqual({
      key: 'to',
      label: 'Destinatario',
      type: 'expression',
      required: true,
    });
  });
});

describe('buildNodeCatalog — community runtime-loaded (FIX 2026-05-30)', () => {
  it('REGRESSION: community_telegram appare nel catalog quando installato', () => {
    listInstalledMock.mockReturnValue([
      {
        def: {
          id: 'community_telegram',
          type: 'action',
          label: 'Telegram',
          description: 'Telegram Bot API 75 actions',
          configFields: [{ key: 'botToken', label: 'Bot Token', type: 'secret', required: true }],
          actions: [
            {
              id: 'send_message',
              label: 'Send Message',
              configFields: [
                { key: 'chatId', label: 'Chat ID', type: 'expression', required: true },
                { key: 'text', label: 'Testo', type: 'textarea', required: true },
              ],
            },
            { id: 'send_photo', label: 'Send Photo', configFields: [] },
          ],
        },
      },
    ]);
    const cat = buildNodeCatalog();
    const tg = cat.find((c) => c.defId === 'community_telegram');
    expect(tg).toBeDefined();
    expect(tg?.label).toBe('Telegram');
    expect(tg?.fields[0]?.key).toBe('botToken');
  });

  it('community multi-action: actions array esposto con id + label', () => {
    listInstalledMock.mockReturnValue([
      {
        def: {
          id: 'community_slack',
          type: 'action',
          label: 'Slack',
          description: 'Slack 57 actions',
          configFields: [{ key: 'token', label: 'OAuth Token', type: 'secret', required: true }],
          actions: [
            {
              id: 'send_message',
              label: 'Send Message',
              category: 'Messages',
              configFields: [
                { key: 'channel', label: 'Channel', type: 'expression', required: true },
              ],
            },
            { id: 'upload_file', label: 'Upload File', category: 'Files', configFields: [] },
          ],
        },
      },
    ]);
    const cat = buildNodeCatalog();
    const slack = cat.find((c) => c.defId === 'community_slack');
    expect(slack?.actions).toHaveLength(2);
    expect(slack?.actions?.[0]?.id).toBe('send_message');
    expect(slack?.actions?.[0]?.category).toBe('Messages');
    expect(slack?.actions?.[0]?.fields[0]?.key).toBe('channel');
  });

  it('fusione bundled + community: 2 bundled + 7 community = 9 entries', () => {
    const mkCommunity = (id: string) => ({
      def: {
        id,
        type: 'action',
        label: id,
        description: '',
        configFields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
      },
    });
    listInstalledMock.mockReturnValue([
      mkCommunity('community_telegram'),
      mkCommunity('community_slack'),
      mkCommunity('community_github'),
      mkCommunity('community_notion'),
      mkCommunity('community_stripe'),
      mkCommunity('community_linear'),
      mkCommunity('community_discord'),
    ]);
    const cat = buildNodeCatalog();
    expect(cat).toHaveLength(9);
    expect(cat.map((c) => c.defId)).toEqual(
      expect.arrayContaining([
        'action_send_email',
        'trigger_imap',
        'community_telegram',
        'community_slack',
        'community_github',
        'community_notion',
        'community_stripe',
        'community_linear',
        'community_discord',
      ]),
    );
  });

  it('de-dup: defId community vince su bundled stesso id (defensive)', () => {
    listInstalledMock.mockReturnValue([
      {
        def: {
          id: 'action_send_email', // collisione defensiva
          type: 'action',
          label: 'OVERRIDDEN',
          description: 'community override',
          configFields: [],
        },
      },
    ]);
    const cat = buildNodeCatalog();
    const email = cat.find((c) => c.defId === 'action_send_email');
    expect(email?.label).toBe('OVERRIDDEN');
    expect(cat).toHaveLength(2); // trigger_imap + action_send_email (1 entry, no dup)
  });

  it('community senza actions: entry non ha campo actions (undefined)', () => {
    listInstalledMock.mockReturnValue([
      {
        def: {
          id: 'community_simple',
          type: 'action',
          label: 'Simple',
          description: '',
          configFields: [{ key: 'url', label: 'URL', type: 'text', required: true }],
        },
      },
    ]);
    const cat = buildNodeCatalog();
    const simple = cat.find((c) => c.defId === 'community_simple');
    expect(simple?.actions).toBeUndefined();
  });

  it('REGRESSION: empty listInstalled → nessuna entry community fallita', () => {
    listInstalledMock.mockReturnValue([]);
    const cat = buildNodeCatalog();
    const communityCount = cat.filter((c) => c.defId.startsWith('community_')).length;
    expect(communityCount).toBe(0);
  });
});

describe('normalizeColumnType', () => {
  it('whitelist: text/varchar/integer/etc passano', () => {
    expect(normalizeColumnType('text')).toBe('text');
    expect(normalizeColumnType('VARCHAR')).toBe('varchar');
    expect(normalizeColumnType('integer')).toBe('integer');
  });

  it('SQL injection / tipi inventati → fallback "text"', () => {
    expect(normalizeColumnType('text; DROP TABLE users')).toBe('text');
    expect(normalizeColumnType('nvarchar')).toBe('text');
    expect(normalizeColumnType(undefined)).toBe('text');
    expect(normalizeColumnType(null)).toBe('text');
    expect(normalizeColumnType(123)).toBe('text');
  });
});

describe('normalizeConstraints', () => {
  it('default: nullable true, unique false, primaryKey false', () => {
    expect(normalizeConstraints({})).toEqual({ nullable: true, unique: false, primaryKey: false });
  });

  it('nullable=false esplicito', () => {
    expect(normalizeConstraints({ nullable: false })).toEqual({
      nullable: false,
      unique: false,
      primaryKey: false,
    });
  });

  it('unique + primaryKey true', () => {
    expect(normalizeConstraints({ unique: true, primaryKey: true })).toEqual({
      nullable: true,
      unique: true,
      primaryKey: true,
    });
  });

  it('input non-object → all defaults', () => {
    expect(normalizeConstraints(null)).toEqual({
      nullable: true,
      unique: false,
      primaryKey: false,
    });
    expect(normalizeConstraints('foo')).toEqual({
      nullable: true,
      unique: false,
      primaryKey: false,
    });
  });
});

describe('ALLOWED_COLUMN_TYPES', () => {
  it('contiene i 14 tipi SQL whitelist (no injection, no vendor-specific)', () => {
    expect(ALLOWED_COLUMN_TYPES).toContain('text');
    expect(ALLOWED_COLUMN_TYPES).toContain('integer');
    expect(ALLOWED_COLUMN_TYPES).toContain('json');
    expect(ALLOWED_COLUMN_TYPES).toContain('uuid');
    expect(ALLOWED_COLUMN_TYPES).not.toContain('nvarchar'); // SQL Server only
  });
});
