/**
 * Format a UTC ISO timestamp as a locale-aware short label.
 * Keeps "today" minimal (HH:mm), older shows DD MMM, very old shows DD MMM YYYY.
 */
export function formatMessageDate(iso: string | Date, locale = 'it-IT', now = new Date()): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';

  const sameDay = d.toDateString() === now.toDateString();
  const sameYear = d.getFullYear() === now.getFullYear();

  if (sameDay) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  if (sameYear) {
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' }).format(d);
  }
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

export function isoNow(): string {
  return new Date().toISOString();
}
