/**
 * JSONPath-lite — `.get(obj, "a.b[0].c")` accessor.
 *
 * NON un full JSONPath compliant — subset pragmatico:
 *  - `.` separator → property access
 *  - `[N]` → array index access
 *  - `[*]` → return all (returns array, not single)
 *
 * No wildcards `..` recursive descent, no slice `[1:5]`, no filter `[?(...)]`.
 *
 * @module sandbox/jsonpath
 */

type PathSegment = { kind: 'prop'; key: string } | { kind: 'index'; n: number } | { kind: 'star' };

function tokenize(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  let i = 0;
  let buf = '';
  const flushBuf = (): void => {
    if (buf.length > 0) {
      out.push({ kind: 'prop', key: buf });
      buf = '';
    }
  };
  while (i < path.length) {
    const c = path[i]!;
    if (c === '.') {
      flushBuf();
      i++;
      continue;
    }
    if (c === '[') {
      flushBuf();
      const end = path.indexOf(']', i);
      if (end < 0) throw new Error(`jsonpath unclosed bracket at ${String(i)}`);
      const inner = path.slice(i + 1, end);
      if (inner === '*') out.push({ kind: 'star' });
      else if (/^-?\d+$/.test(inner)) out.push({ kind: 'index', n: parseInt(inner, 10) });
      else if (/^['"].*['"]$/.test(inner)) out.push({ kind: 'prop', key: inner.slice(1, -1) });
      else throw new Error(`jsonpath invalid bracket content: "${inner}"`);
      i = end + 1;
      continue;
    }
    buf += c;
    i++;
  }
  flushBuf();
  return out;
}

/** Accessa un path; restituisce undefined se non trovato. */
export function get(obj: unknown, path: string): unknown {
  const segments = tokenize(path);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (seg.kind === 'prop') {
      cur = (cur as Record<string, unknown>)[seg.key];
    } else if (seg.kind === 'index') {
      if (!Array.isArray(cur)) return undefined;
      const idx = seg.n < 0 ? cur.length + seg.n : seg.n;
      cur = cur[idx];
    } else {
      // star
      if (!Array.isArray(cur)) return undefined;
      return cur; // return whole array — il caller deve gestire il restante path manualmente
    }
  }
  return cur;
}

/** Get with default fallback. */
export function getOr<T>(obj: unknown, path: string, fallback: T): T {
  const v = get(obj, path);
  return v === undefined || v === null ? fallback : (v as T);
}

/**
 * Set su path (immutable: ritorna nuovo objet con il valore settato).
 *
 * Crea automaticamente nested objects se non esistono. Array creati se path
 * usa `[N]`. NON modifica l'oggetto originale.
 */
export function set<T>(obj: T, path: string, value: unknown): T {
  const segments = tokenize(path);
  if (segments.length === 0) return value as T;
  const root = Array.isArray(obj) ? [...obj] : { ...(obj as object) };
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1]!;
    if (seg.kind === 'star')
      throw new Error('jsonpath set: wildcard non supportato in path intermedio');
    if (seg.kind === 'prop') {
      const k = seg.key;
      const existing: unknown = (cur as Record<string, unknown>)[k];
      const fresh: Record<string, unknown> | unknown[] =
        next.kind === 'index'
          ? Array.isArray(existing)
            ? [...(existing as unknown[])]
            : []
          : existing && typeof existing === 'object'
            ? { ...(existing as Record<string, unknown>) }
            : {};
      (cur as Record<string, unknown>)[k] = fresh;
      cur = fresh;
    } else {
      // index
      const arr = cur as unknown[];
      const idx: number = seg.n < 0 ? arr.length + seg.n : seg.n;
      const existing: unknown = arr[idx];
      const fresh: Record<string, unknown> | unknown[] =
        next.kind === 'index'
          ? Array.isArray(existing)
            ? [...(existing as unknown[])]
            : []
          : existing && typeof existing === 'object'
            ? { ...(existing as Record<string, unknown>) }
            : {};
      arr[idx] = fresh;
      cur = fresh;
    }
  }
  const last = segments[segments.length - 1]!;
  if (last.kind === 'prop') {
    (cur as Record<string, unknown>)[last.key] = value;
  } else if (last.kind === 'index') {
    const arr = cur as unknown[];
    const idx = last.n < 0 ? arr.length + last.n : last.n;
    arr[idx] = value;
  } else {
    throw new Error('jsonpath set: wildcard non supportato come last segment');
  }
  return root as T;
}

/** Check se path esiste (anche se il valore è null). */
export function has(obj: unknown, path: string): boolean {
  const segments = tokenize(path);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return false;
    if (typeof cur !== 'object') return false;
    if (seg.kind === 'prop') {
      if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return false;
      cur = (cur as Record<string, unknown>)[seg.key];
    } else if (seg.kind === 'index') {
      if (!Array.isArray(cur)) return false;
      const idx = seg.n < 0 ? cur.length + seg.n : seg.n;
      if (idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
    } else {
      return Array.isArray(cur);
    }
  }
  return true;
}
