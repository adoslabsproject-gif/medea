/**
 * /api/v1/file-browser — list files/directories within the tenant's sandbox.
 *
 *   GET /?path=<relative-or-absolute>   → { entries, cwd, parent, roots }
 *
 * Security: paths are resolved against the tenant's root
 * (/var/data/flowforge/tenants/<tenantId>/files) OR a globally-allowlisted dir
 * (MEDEA_FILE_ALLOWLIST). Path traversal attempts (`../../etc/passwd`)
 * are rejected with 403.
 *
 * Used by the FilePicker / DirectoryPicker UI components in the editor so
 * operators don't have to type absolute paths by hand for File Read / Write
 * / Watch nodes.
 */

import { Hono } from 'hono';
import { readdir, stat } from 'node:fs/promises';
import { resolve, sep, dirname, basename } from 'node:path';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';

interface BrowserEntry {
  name: string;
  type: 'file' | 'dir';
  sizeBytes?: number;
  mtime: string;
}

interface BrowserResponse {
  /** Absolute path of the currently-listed directory. */
  cwd: string;
  /** Path to navigate "up" to. null when at the sandbox root. */
  parent: string | null;
  /** All allowed roots the user can navigate between. First is the tenant default. */
  roots: { label: string; path: string }[];
  entries: BrowserEntry[];
}

function getTenantRoot(tenantId: string): string {
  const safeTenant = (tenantId || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const baseDir = process.env.MEDEA_DATA_DIR ?? '/var/data/flowforge';
  return resolve(baseDir, 'tenants', safeTenant, 'files');
}

function getGlobalAllowlist(): string[] {
  const envList = process.env.MEDEA_FILE_ALLOWLIST ?? '';
  return envList.split(':').map((p) => p.trim()).filter(Boolean).map((p) => resolve(p));
}

function isPathAllowed(abs: string, tenantId: string): boolean {
  const tenantRoot = getTenantRoot(tenantId);
  if (abs === tenantRoot || abs.startsWith(tenantRoot + sep)) return true;
  return getGlobalAllowlist().some((r) => abs === r || abs.startsWith(r + sep));
}

export function createFileBrowserRoutes(): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const tenantRoot = getTenantRoot(getTenantId(c));
    const globalRoots = getGlobalAllowlist();

    // Resolve the requested path. Empty/missing → tenant root.
    const rawPath = c.req.query('path') ?? '';
    const target = rawPath
      ? rawPath.startsWith('/') ? resolve(rawPath) : resolve(tenantRoot, rawPath)
      : tenantRoot;

    if (!isPathAllowed(target, getTenantId(c))) {
      return c.json({ error: `Path "${target}" outside allowlisted directories` }, 403);
    }

    // Auto-create the tenant root on first browse so the UI never shows
    // "ENOENT" for a fresh tenant — they just see an empty directory.
    try {
      const s = await stat(target);
      if (!s.isDirectory()) return c.json({ error: `Path "${target}" is not a directory` }, 400);
    } catch (err) {
      if (target === tenantRoot && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Empty tenant root — return empty listing rather than 404.
        return c.json<BrowserResponse>({
          cwd: tenantRoot,
          parent: null,
          roots: [{ label: 'Sandbox tenant', path: tenantRoot }, ...globalRoots.map((p) => ({ label: p, path: p }))],
          entries: [],
        });
      }
      logger.warn({ err, target }, 'file-browser stat failed');
      return c.json({ error: 'Directory non leggibile' }, 500);
    }

    let entries: BrowserEntry[] = [];
    try {
      const names = await readdir(target);
      const items = await Promise.all(names.map(async (name): Promise<BrowserEntry | null> => {
        try {
          const s = await stat(resolve(target, name));
          return {
            name,
            type: s.isDirectory() ? 'dir' : 'file',
            ...(s.isFile() ? { sizeBytes: s.size } : {}),
            mtime: s.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      }));
      entries = items.filter((x): x is BrowserEntry => x !== null);
      // Directories first, then files, both alphabetical.
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch (err) {
      logger.warn({ err, target }, 'file-browser readdir failed');
      return c.json({ error: 'Directory non leggibile' }, 500);
    }

    // parent: only when target is NOT one of the configured roots.
    const isAtRoot = target === tenantRoot || globalRoots.includes(target);
    const parent = isAtRoot ? null : dirname(target);
    // Parent must still be inside an allowed root, otherwise null
    const safeParent = parent && isPathAllowed(parent, getTenantId(c)) ? parent : null;

    return c.json<BrowserResponse>({
      cwd: target,
      parent: safeParent,
      roots: [
        { label: `Sandbox ${basename(tenantRoot)}`, path: tenantRoot },
        ...globalRoots.map((p) => ({ label: p, path: p })),
      ],
      entries,
    });
  });

  return app;
}
