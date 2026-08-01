/**
 * /api/v1/nodes — public catalog of all NodeDefs registered in the runtime.
 *
 * Includes:
 *   • Bundled stdlib + db + integrations + ai-agents + llm nodes (static at boot)
 *   • Installed community nodes (dynamic — refreshed on install/uninstall)
 *
 * Returns only the metadata (label, icon, color, configFields, outputs,
 * actions for multi-action nodes). No executors, no secrets.
 *
 * Filtering:
 *   ?type=trigger|action|ai|logic   — narrow by category
 *   ?package=stdlib|community|...   — narrow by source package
 *
 * Performance: the bundled catalog is computed ONCE (the IIFE below) since
 * its NodeDefs can't change at runtime. Community nodes are appended on
 * each request — cheap (a handful of entries, no heavy work).
 */

import { Hono } from 'hono';
import { stdlibNodes } from '@flowforge/nodes-stdlib';
import { dbNodes } from '@flowforge/nodes-db';
import { coreIntegrationNodes } from '@flowforge/nodes-integrations-core';
import { italianConnectors } from '@flowforge/nodes-integrations-italia';
import { aiAgentNodes } from '@flowforge/nodes-ai-agents';
import { llmNodes } from '@flowforge/nodes-llm';
import { listInstalled } from '@/services/community-nodes.service.js';
import type { NodeDef } from '@flowforge/core-schema';

interface ConfigFieldDescriptor {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  options?: string[];
}

interface ActionDescriptor {
  id: string;
  label: string;
  description?: string;
  category?: string;
  aiAction?: boolean;
  /** Resource/Operation: id della risorsa cui appartiene questa operazione. */
  resource?: string;
  configFields: ConfigFieldDescriptor[];
}

interface ResourceDescriptor {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  configFields: ConfigFieldDescriptor[];
}

interface NodeDescriptor {
  id: string;
  type: string;
  label: string;
  icon: string;
  color: string;
  description: string;
  configFields: ConfigFieldDescriptor[];
  actions?: ActionDescriptor[];
  /** Resource/Operation: entità risorsa (label/icona/descrizione/campi condivisi). */
  resources?: ResourceDescriptor[];
  outputs: string[];
  vendor: string | undefined;
  version: string | undefined;
  package: string;
  /** Verification status — only meaningful for `package === 'community'`. */
  verified?: boolean;
  /** Deprecated nodes are shown in the palette LAST and greyed out. */
  deprecated?: boolean;
}

function mapField(f: NonNullable<NodeDef['configFields']>[number]): ConfigFieldDescriptor {
  const out: ConfigFieldDescriptor = {
    key: f.key,
    label: f.label,
    type: f.type ?? 'text',
    required: f.required ?? false,
  };
  if (f.placeholder !== undefined) out.placeholder = f.placeholder;
  if (f.help !== undefined) out.help = f.help;
  if (f.defaultValue !== undefined) out.defaultValue = f.defaultValue;
  if (f.options !== undefined) out.options = f.options;
  return out;
}

function mapDef(d: NodeDef, pkg: string, verified?: boolean): NodeDescriptor {
  const out: NodeDescriptor = {
    id: d.id,
    type: d.type,
    label: d.label,
    icon: d.icon,
    color: d.color,
    description: d.description,
    configFields: (d.configFields ?? []).map(mapField),
    outputs: d.outputs ?? [],
    vendor: d.vendor,
    version: d.version,
    package: pkg,
  };
  if (d.actions && d.actions.length > 0) {
    out.actions = d.actions.map((a) => {
      const action: ActionDescriptor = {
        id: a.id,
        label: a.label,
        configFields: (a.configFields ?? []).map(mapField),
      };
      if (a.description !== undefined) action.description = a.description;
      if (a.category !== undefined) action.category = a.category;
      if (a.aiAction !== undefined) action.aiAction = a.aiAction;
      if (a.resource !== undefined) action.resource = a.resource;
      return action;
    });
  }
  if (d.resources && d.resources.length > 0) {
    out.resources = d.resources.map((r) => {
      const res: ResourceDescriptor = { id: r.id, label: r.label, configFields: (r.configFields ?? []).map(mapField) };
      if (r.description !== undefined) res.description = r.description;
      if (r.icon !== undefined) res.icon = r.icon;
      return res;
    });
  }
  if (verified !== undefined) out.verified = verified;
  if (d.deprecated) out.deprecated = true;
  return out;
}

const STATIC_CATALOG: NodeDescriptor[] = (() => {
  const out: NodeDescriptor[] = [];
  for (const [pkg, mods] of [
    ['stdlib', stdlibNodes],
    ['db', dbNodes],
    ['integrations-core', coreIntegrationNodes],
    ['integrations-italia', italianConnectors],
    ['ai-agents', aiAgentNodes],
    ['llm', llmNodes],
  ] as const) {
    for (const mod of mods) {
      out.push(mapDef(mod.def, pkg));
    }
  }
  return out;
})();

function currentCatalog(): NodeDescriptor[] {
  const community = listInstalled().map((n) => mapDef(n.def, 'community', n.verified));
  return [...STATIC_CATALOG, ...community];
}

export function createNodesCatalogRoutes(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const typeFilter = c.req.query('type');
    const packageFilter = c.req.query('package');
    let filtered = currentCatalog();
    if (typeFilter !== undefined) filtered = filtered.filter((n) => n.type === typeFilter);
    if (packageFilter !== undefined) filtered = filtered.filter((n) => n.package === packageFilter);
    return c.json({ nodes: filtered, total: filtered.length });
  });

  // Schema introspection di UN nodo (defId) — i campi "live" del nodo: config
  // fields, outputs, actions e versione corrente. Copre stdlib + integrations +
  // ai/llm + community/custom installati (currentCatalog). Usato per validare/
  // generare config a runtime o da tool esterni (SDK custom node author).
  app.get('/:defId/schema', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const defId = c.req.param('defId');
    const node = currentCatalog().find((n) => n.id === defId);
    if (!node) return c.json({ error: 'Node not found', defId }, 404);
    return c.json({
      defId: node.id,
      type: node.type,
      version: node.version ?? null,
      package: node.package,
      configFields: node.configFields,
      outputs: node.outputs,
      ...(node.actions ? { actions: node.actions } : {}),
      ...(node.deprecated ? { deprecated: true } : {}),
    });
  });

  return app;
}
