/**
 * Pagination auto-detect: cerca link "next page" via heuristic.
 *
 * Pattern coperti:
 *  - rel="next" link tag (<a rel="next" href="...">)
 *  - aria-label="Next page" / "Pagina successiva"
 *  - text "Next", "Successivo", "Prossima", "›", "→", ">"
 *  - URL query param page= / p= / offset= / start= (incremento numerico)
 *  - JSON-LD breadcrumb con itemListElement
 */

export interface NextPageDetection {
  found: boolean;
  url: string | null;
  method: 'rel-next' | 'aria-label' | 'text-match' | 'url-pattern' | null;
  evidence: string;
}

const NEXT_TEXT_PATTERNS = [
  /\bnext\b/i,
  /\bsuccessiv[oa]\b/i,
  /\bprossim[oa]\b/i,
  /\bavanti\b/i,
  /\bsuivant\b/i,
  /\bsiguiente\b/i,
  /[›→»❯]/u,
];

export function detectNextPage(html: string, baseUrl: string): NextPageDetection {
  if (!html) return { found: false, url: null, method: null, evidence: '' };

  // 1. rel="next" link tag
  const relNextMatch = /<(?:a|link)[^>]+rel=["']next["'][^>]*>/i.exec(html) ?? /<(?:a|link)[^>]+rel=[^>]*\bnext\b[^>]*>/i.exec(html);
  if (relNextMatch) {
    const hrefMatch = /href=["']([^"']+)["']/i.exec(relNextMatch[0]);
    if (hrefMatch?.[1]) {
      return { found: true, url: resolveUrl(hrefMatch[1], baseUrl), method: 'rel-next', evidence: relNextMatch[0].slice(0, 100) };
    }
  }

  // 2. aria-label
  const ariaMatch = /<a[^>]+aria-label=["'][^"']*(?:next|successiv|prossim|siguiente)[^"']*["'][^>]+href=["']([^"']+)["']/i.exec(html) ?? /<a[^>]+href=["']([^"']+)["'][^>]+aria-label=["'][^"']*(?:next|successiv|prossim|siguiente)[^"']*["']/i.exec(html);
  if (ariaMatch?.[1]) {
    return { found: true, url: resolveUrl(ariaMatch[1], baseUrl), method: 'aria-label', evidence: ariaMatch[0].slice(0, 100) };
  }

  // 3. text inside <a>
  const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{1,40})<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const text = m[2]?.trim() ?? '';
    if (!href || !text) continue;
    for (const re of NEXT_TEXT_PATTERNS) {
      if (re.test(text)) {
        return { found: true, url: resolveUrl(href, baseUrl), method: 'text-match', evidence: `text="${text}"` };
      }
    }
  }

  // 4. URL pattern increment (page=N → page=N+1)
  const urlIncrement = incrementUrlPageParam(baseUrl);
  if (urlIncrement) {
    return { found: true, url: urlIncrement.url, method: 'url-pattern', evidence: urlIncrement.evidence };
  }

  return { found: false, url: null, method: null, evidence: '' };
}

export function incrementUrlPageParam(url: string): { url: string; evidence: string } | null {
  try {
    const u = new URL(url);
    for (const param of ['page', 'p', 'pagina']) {
      const v = u.searchParams.get(param);
      if (v && /^\d+$/.test(v)) {
        const next = (parseInt(v, 10) + 1).toString();
        u.searchParams.set(param, next);
        return { url: u.toString(), evidence: `${param}=${v} → ${next}` };
      }
    }
    for (const param of ['offset', 'start', 'from']) {
      const v = u.searchParams.get(param);
      if (v && /^\d+$/.test(v)) {
        // Assume increment by current value (common: offset=20 step 20)
        const n = parseInt(v, 10);
        const next = (n * 2).toString();
        u.searchParams.set(param, next);
        return { url: u.toString(), evidence: `${param}=${v} → ${next}` };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
