/**
 * Pending-secrets analysis — workflow post-finalize UX.
 *
 * Why
 * ───
 * A scaffold-generated workflow may reference half a dozen `{{secrets.X}}`
 * placeholders. The user enables the workflow and the FIRST node fails with
 * a cryptic `url required` because `DOMAIN_TARGET_SITEMAP` was never set.
 *
 * `analyzePendingSecrets` scans the workflow + the tenant's currently
 * configured secrets and returns the list of placeholders that are still
 * unbound. The UI surfaces this as a banner with a "Configura ora" CTA
 * BEFORE the user clicks "Enable".
 *
 * Pure — no I/O. Consumer passes both the workflow and the tenant secrets
 * snapshot.
 *
 * @module services/ai-scaffold/pending-secrets
 */

const SECRET_REF_RE = /\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface PendingSecretRef {
  /** Bare secret name, e.g. `OPENAI_API_KEY`. */
  name: string;
  /** Node IDs that reference this secret (deduped, sorted). */
  referencedBy: string[];
  /** Field names on those nodes that contain the reference (deduped, sorted). */
  fields: string[];
}

export interface PendingSecretsInput {
  nodes: readonly {
    id: string;
    config: Readonly<Record<string, unknown>>;
  }[];
  /** Secrets the tenant has already configured (case-sensitive name match). */
  configuredSecrets: ReadonlySet<string>;
}

/**
 * Returns the secrets referenced by the workflow that are NOT yet configured
 * on the tenant. Sorted alphabetically by name. Each entry includes the
 * referencing node ids and fields so the UI can deep-link the user to the
 * right node.
 */
export function analyzePendingSecrets(input: PendingSecretsInput): PendingSecretRef[] {
  const byName = new Map<string, { nodes: Set<string>; fields: Set<string> }>();

  for (const node of input.nodes) {
    for (const [field, raw] of Object.entries(node.config)) {
      const refs = extractSecretReferences(raw);
      if (refs.length === 0) continue;
      for (const name of refs) {
        if (input.configuredSecrets.has(name)) continue; // already configured
        const entry = byName.get(name) ?? { nodes: new Set<string>(), fields: new Set<string>() };
        entry.nodes.add(node.id);
        entry.fields.add(field);
        byName.set(name, entry);
      }
    }
  }

  return Array.from(byName.entries())
    .map(([name, { nodes, fields }]) => ({
      name,
      referencedBy: Array.from(nodes).sort(),
      fields: Array.from(fields).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walk arbitrary value shapes (strings, nested objects, arrays) and yield
 * every `secrets.X` name referenced. Workflow config is `Record<string,
 * string>` today, but the helper is shape-tolerant for future schemas.
 */
function extractSecretReferences(value: unknown): string[] {
  if (typeof value === 'string') {
    const out: string[] = [];
    for (const match of value.matchAll(SECRET_REF_RE)) {
      const name = match[1];
      if (name) out.push(name);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => extractSecretReferences(v));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => extractSecretReferences(v));
  }
  return [];
}
